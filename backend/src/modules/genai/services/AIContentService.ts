// backend/src/modules/genai/services/AIContentService.ts
// FIXED: OpenAI → Gemini → DeepSeek/Ollama priority order
// FIXED: Better error messages, robust JSON parsing, no empty-question silent failures

import axios, { AxiosRequestConfig } from 'axios';
import { injectable } from 'inversify';
import { HttpError, InternalServerError } from 'routing-controllers';
import { extractJSONFromMarkdown } from '../utils/extractJSONFromMarkdown.js';
import { cleanTranscriptLines } from '../utils/cleanTranscriptLines.js';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { aiConfig } from '#root/config/ai.js';

// --- Type Definitions ---
export interface TranscriptSegment {
  end_time: string;
  transcript_lines: string[];
}

export interface GeneratedQuestion {
  segmentId?: string;
  questionType?: string;
  questionText: string;
  options?: Array<{ text: string; correct?: boolean; explanation?: string }>;
  solution?: any;
  isParameterized?: boolean;
  timeLimitSeconds?: number;
  points?: number;
}

export type QuestionType = 'SOL' | 'SML' | 'OTL' | 'NAT' | 'DES';
export type QuestionSpec = Partial<Record<QuestionType, number>>;

@injectable()
export class AIContentService {
  private readonly ollamaApiBaseUrl = `http://${aiConfig.serverIP}:${aiConfig.serverPort}/api`;
  private readonly llmApiUrl = `${this.ollamaApiBaseUrl}/generate`;

  // OpenAI (primary — fastest, most reliable)
  private readonly openaiApiKey = process.env.OPENAI_API_KEY;
  private readonly openaiApiUrl = 'https://api.openai.com/v1/chat/completions';
  private readonly openaiModel = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';

  // Google Gemini (secondary fallback — free tier available)
  private readonly geminiApiKey = process.env.GEMINI_API_KEY;
  private readonly geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  private get geminiApiUrl() {
    return `https://generativelanguage.googleapis.com/v1/models/${this.geminiModel}:generateContent`;
  }

  // ─── Provider Selection ──────────────────────────────────────────────────
  // Priority: Gemini → OpenAI → Ollama/DeepSeek
  // Gemini and OpenAI are cloud APIs — no local setup needed.
  // Ollama is only used if no cloud provider keys are configured.
  private getPreferredProvider(): 'openai' | 'gemini' | 'ollama' {
    if (this.geminiApiKey && this.geminiApiKey.length > 10) {
      return 'gemini';
    }
    if (this.openaiApiKey && this.openaiApiKey.startsWith('sk-')) {
      return 'openai';
    }
    return 'ollama';
  }

  // Build the ordered fallback chain: preferred first, then others, no duplicates.
  // If a cloud provider is configured, do not fall back to Ollama by default.
  private getProviderChain(): Array<'openai' | 'gemini' | 'ollama'> {
    const chain: Array<'openai' | 'gemini' | 'ollama'> = [];
    if (this.geminiApiKey && this.geminiApiKey.length > 10) {
      chain.push('gemini');
    }
    if (this.openaiApiKey && this.openaiApiKey.startsWith('sk-')) {
      chain.push('openai');
    }
    if (chain.length === 0) {
      chain.push('ollama');
    }
    return chain;
  }

  // ─── Proxy / Request Config ──────────────────────────────────────────────
  private createProxyAgent() {
    try {
      return new SocksProxyAgent('socks5://localhost:1055');
    } catch (error) {
      console.error(`Failed to create SOCKS proxy agent: ${error}`);
      return undefined;
    }
  }

  private getRequestConfig(): AxiosRequestConfig {
    const config: AxiosRequestConfig = { timeout: 180000 };
    try {
      const isLocal =
        this.ollamaApiBaseUrl.includes('localhost') ||
        this.ollamaApiBaseUrl.includes('127.0.0.1');
      if (aiConfig.useProxy && !isLocal) {
        const proxyAgent = this.createProxyAgent();
        if (proxyAgent) {
          config.httpAgent = proxyAgent;
          config.httpsAgent = proxyAgent;
        }
      }
    } catch (error) {
      console.error(`[AIContentService] Error configuring request: ${error}`);
    }
    return config;
  }

  // ─── Individual Provider Calls ───────────────────────────────────────────

  private async callOpenAI(prompt: string, systemPrompt?: string): Promise<string> {
    if (!this.openaiApiKey) throw new Error('OpenAI API key not configured');

    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    try {
      const response = await axios.post(
        this.openaiApiUrl,
        {
          model: this.openaiModel,
          messages,
          temperature: 0.2,
          max_tokens: 4000,
        },
        {
          headers: {
            Authorization: `Bearer ${this.openaiApiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 60000,
        }
      );
      const content = response.data.choices?.[0]?.message?.content || '';
      if (!content) throw new Error('OpenAI returned empty content');
      return content;
    } catch (err: any) {
      // Surface the actual OpenAI error message for easier debugging
      const openaiMsg =
        err.response?.data?.error?.message ||
        err.response?.data?.message ||
        err.message;
      throw new Error(`OpenAI call failed: ${openaiMsg}`);
    }
  }

  private async callGemini(prompt: string, systemPrompt?: string): Promise<string> {
    if (!this.geminiApiKey) throw new Error('Gemini API key not configured');

    // Gemini 1.5 supports system instructions, but let's include it in the prompt for compatibility
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;

    const requestBody: any = {
      contents: [{ parts: [{ text: fullPrompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4000 },
    };

    try {
      const response = await axios.post(
        `${this.geminiApiUrl}?key=${this.geminiApiKey}`,
        requestBody,
        { timeout: 60000 }
      );
      const content =
        response.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!content) throw new Error('Gemini returned empty content');
      return content;
    } catch (err: any) {
      const geminiMsg =
        err.response?.data?.error?.message ||
        err.response?.data?.message ||
        err.message;
      throw new Error(`Gemini call failed: ${geminiMsg}`);
    }
  }

  private async callOllama(prompt: string, model: string): Promise<string> {
    const config = this.getRequestConfig();
    try {
      const response = await axios.post(
        this.llmApiUrl,
        { model, prompt, stream: false, options: { temperature: 0.1, top_p: 0.9 } },
        config
      );
      const content = response.data?.response || '';
      if (!content) throw new Error(`Ollama (${model}) returned empty response`);
      return content;
    } catch (err: any) {
      const msg = err.response?.data?.error || err.message;
      throw new Error(
        `Ollama call failed for model "${model}": ${msg}. ` +
          `Make sure Ollama is running locally (ollama serve) and the model is pulled (ollama pull ${model}).`
      );
    }
  }

  // ─── Unified AI Call with Provider Fallback Chain ────────────────────────
  // NOTE: The `model` param from the frontend (e.g. "deepseek-r1:70b") is only
  // used when Ollama is selected. For OpenAI/Gemini the env-configured model is used.
  private async callAI(
    prompt: string,
    ollamaModel = 'gemma3',
    systemPrompt?: string
  ): Promise<string> {
    const chain = this.getProviderChain();
    console.log(`[AIContentService] Provider chain: ${chain.join(' → ')}`);

    let lastError: Error | null = null;

    for (const provider of chain) {
      try {
        switch (provider) {
          case 'openai':
            if (!this.openaiApiKey || !this.openaiApiKey.startsWith('sk-')) {
              console.log('[AIContentService] Skipping OpenAI — no valid key');
              continue;
            }
            console.log(`[AIContentService] Calling OpenAI (${this.openaiModel})...`);
            return await this.callOpenAI(prompt, systemPrompt);

          case 'gemini':
            if (!this.geminiApiKey || this.geminiApiKey.length <= 10) {
              console.log('[AIContentService] Skipping Gemini — no valid key');
              continue;
            }
            console.log('[AIContentService] Calling Gemini (gemini-1.5-flash)...');
            return await this.callGemini(prompt, systemPrompt);

          case 'ollama':
            console.log(`[AIContentService] Calling Ollama (${ollamaModel})...`);
            return await this.callOllama(prompt, ollamaModel);
        }
      } catch (err: any) {
        console.warn(`[AIContentService] Provider "${provider}" failed: ${err.message}`);
        console.error(`[AIContentService] Full error for ${provider}:`, err);
        lastError = err;
        // Continue to next provider in chain
      }
    }

    throw new InternalServerError(
      `All AI providers failed to generate questions. ` +
        `Last error: ${lastError?.message}. ` +
        `Check your OPENAI_API_KEY and GEMINI_API_KEY in .env`
    );
  }

  // ─── Transcript Segmentation ─────────────────────────────────────────────
  public async segmentTranscript(
    transcript: string,
    model = 'gemma3',
    desiredSegments = 3
  ): Promise<Record<string, string>> {
    if (!transcript?.trim()) {
      throw new HttpError(400, 'Transcript text is required and must be non-empty.');
    }

    console.log(
      `[segmentTranscript] Processing transcript length: ${transcript.length} chars`
    );

    const prompt = `Analyze the following lecture transcript. Segment into meaningful subtopics (max ${desiredSegments} segments).
Response must be ONLY a valid JSON array, no markdown, no explanation.
Use property name "transcript_lines" exactly (array of strings).
Use "end_time" as the segment identifier (string like "01:30.000").

Example output:
[
  {
    "end_time": "01:30.000",
    "transcript_lines": ["First chunk of text here.", "Second chunk here."]
  },
  {
    "end_time": "03:00.000",
    "transcript_lines": ["Third chunk here."]
  }
]

Transcript:
${transcript}

JSON array only:`;

    let segments: TranscriptSegment[] = [];

    try {
      const generatedText = await this.callAI(prompt, model);
      console.log(
        '[segmentTranscript] Response preview:',
        generatedText.slice(0, 300)
      );

      if (!generatedText) throw new Error('Empty response from AI');

      try {
        const cleaned = extractJSONFromMarkdown(generatedText);
        const arrayMatch = cleaned.match(/\[[\s\S]*?\]/);
        const jsonToParse = arrayMatch ? arrayMatch[0] : cleaned;

        const fixedJson = jsonToParse
          .replace(/,\s*([}\]])/g, '$1')
          .replace(/}\s*{/g, '},{')
          .replace(/]\s*\[/g, '],[')
          .replace(/\s+/g, ' ')
          .trim();

        segments = JSON.parse(fixedJson);

        if (!Array.isArray(segments) || segments.length === 0) {
          throw new Error('Parsed segments invalid or empty.');
        }

        segments.forEach((seg, idx) => {
          if (!seg.end_time || !Array.isArray(seg.transcript_lines)) {
            throw new Error(`Invalid segment at index ${idx}`);
          }
        });

        console.log(
          `[segmentTranscript] Successfully parsed ${segments.length} segments.`
        );
      } catch (parseError: any) {
        console.error(
          '[segmentTranscript] JSON parse failed, using fallback segmentation:',
          parseError.message
        );
        segments = this.fallbackSegment(transcript, desiredSegments);
      }
    } catch (error: any) {
      console.error(
        '[segmentTranscript] AI call failed, using fallback:',
        error.message
      );
      segments = this.fallbackSegment(transcript, desiredSegments);
    }

    const result: Record<string, string> = {};
    for (const seg of segments) {
      try {
        const clean = cleanTranscriptLines(seg.transcript_lines);
        if (clean?.trim()) {
          result[seg.end_time] = clean;
        }
      } catch (e) {
        console.warn(`[segmentTranscript] Failed cleaning segment ${seg.end_time}:`, e);
      }
    }

    if (Object.keys(result).length === 0) {
      result['full'] = transcript;
    }

    console.log(
      `[segmentTranscript] Done. Returning ${Object.keys(result).length} segments.`
    );
    return result;
  }

  private fallbackSegment(
    transcript: string,
    desiredSegments = 3
  ): TranscriptSegment[] {
    // For plain text (no timestamps), split by paragraphs or length
    const lines = transcript
      .split(/\n+/)
      .map(l => l.trim())
      .filter(l => l.length > 0);

    const minLines = 5;
    const segments: TranscriptSegment[] = [];

    if (lines.length <= minLines) {
      segments.push({ end_time: 'full', transcript_lines: lines });
    } else {
      const linesPerSegment = Math.max(
        minLines,
        Math.ceil(lines.length / desiredSegments)
      );
      for (let i = 0; i < lines.length; i += linesPerSegment) {
        const segmentLines = lines.slice(i, i + linesPerSegment);
        const segIndex = Math.floor(i / linesPerSegment) + 1;
        segments.push({
          end_time: `segment_${segIndex}`,
          transcript_lines: segmentLines,
        });
      }
    }

    return segments;
  }

  // ─── Question Generation Prompt ──────────────────────────────────────────
  private createQuestionPrompt(
    questionType: string,
    count: number,
    transcriptContent: string,
    instructions?: string
  ): string {
    const instructionText = instructions
      ? `\nAdditional instructions: ${instructions}\n`
      : '';

    return `You are an expert educator and quiz creator. Generate EXACTLY ${count} multiple-choice question(s) based on the content below.

STRICT RULES:
- Generate EXACTLY ${count} question(s) — no more, no less
- Each question must have EXACTLY 4 options (A, B, C, D)
- EXACTLY ONE option must have "correct": true
- All other options must have "correct": false
- Output ONLY a raw JSON array — no markdown, no code blocks, no explanation
- The JSON must be valid and parseable
${instructionText}
Output format (JSON array):
[
  {
    "questionText": "Clear, specific question based on the content?",
    "options": [
      { "text": "Correct answer here", "correct": true, "explanation": "This is correct because..." },
      { "text": "Wrong option B", "correct": false, "explanation": "This is wrong because..." },
      { "text": "Wrong option C", "correct": false, "explanation": "This is wrong because..." },
      { "text": "Wrong option D", "correct": false, "explanation": "This is wrong because..." }
    ],
    "solution": "The correct answer is X because...",
    "timeLimitSeconds": 60,
    "points": 5
  }
]

Content to generate questions from:
${transcriptContent}

JSON array (${count} question${count > 1 ? 's' : ''}):`;
  }

  // ─── Main Question Generation ─────────────────────────────────────────────
  public async generateQuestions(args: {
    segments: Record<string | number, string>;
    globalQuestionSpecification: QuestionSpec[];
    model?: string;
    instructions?: string;
  }): Promise<GeneratedQuestion[]> {
    const {
      segments,
      globalQuestionSpecification,
      model = 'gemma3',
      instructions,
    } = args;

    if (!segments || Object.keys(segments).length === 0) {
      throw new HttpError(400, 'No content segments provided.');
    }
    if (
      !globalQuestionSpecification?.length ||
      !Object.keys(globalQuestionSpecification[0] || {}).length
    ) {
      throw new HttpError(400, 'Question specification is required.');
    }

    const questionSpecs = globalQuestionSpecification[0];
    const allQuestions: GeneratedQuestion[] = [];
    const provider = this.getPreferredProvider();
    console.log(`[generateQuestions] Provider: ${provider}, Ollama fallback model: ${model}`);

    const systemPrompt = `You are an expert educator. Generate quiz questions in valid JSON array format. Output ONLY the JSON array with no additional text, markdown, or explanation.`;

    for (const rawSegmentId in segments) {
      const segmentId = String(rawSegmentId);
      const transcript = segments[segmentId];
      console.log(`[generateQuestions] Segment "${segmentId}" transcript length: ${transcript?.length || 0}`);
      if (!transcript || !transcript.trim()) {
        console.warn(`[generateQuestions] Skipping empty segment "${segmentId}"`);
        continue;
      }
      if (transcript.trim().length < 10) {
        throw new HttpError(400, `Transcript too short for segment "${segmentId}". Minimum 10 characters required.`);
      }

      for (const [type, count] of Object.entries(questionSpecs)) {
        if (typeof count !== 'number' || count <= 0) continue;

        console.log(
          `[generateQuestions] Generating ${count} ${type} question(s) for segment "${segmentId}"...`
        );

        try {
          const prompt = this.createQuestionPrompt(type, count, transcript, instructions);
          const text = await this.callAI(prompt, model, systemPrompt);

          console.log(`[generateQuestions] AI response for ${type}: ${text.slice(0, 200)}...`);

          if (!text || !text.trim()) {
            console.warn(
              `[generateQuestions] Empty response for type "${type}", segment "${segmentId}"`
            );
            continue;
          }

          // Try to extract JSON — handle cases where model wraps in markdown
          let cleaned = extractJSONFromMarkdown(text);

          // Find the JSON array in the response
          const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
          if (arrayMatch) {
            cleaned = arrayMatch[0];
          }

          let parsed: any[];
          try {
            parsed = JSON.parse(cleaned);
            if (!Array.isArray(parsed)) {
              parsed = [parsed];
            }
          } catch (parseError: any) {
            console.error(
              `[generateQuestions] JSON parse failed for "${type}":`,
              parseError.message
            );
            console.error('[generateQuestions] Raw response:', text.slice(0, 800));
            throw new HttpError(500, `AI returned invalid JSON for ${type}: ${parseError.message}. Raw response: ${text.slice(0, 200)}`);
          }

          let addedCount = 0;
          for (const q of parsed) {
            // Support both "questionText" and "question" field names
            const questionText =
              typeof q.questionText === 'string'
                ? q.questionText.trim()
                : typeof q.question === 'string'
                ? q.question.trim()
                : '';

            if (!questionText) {
              console.warn('[generateQuestions] Skipping question with empty text');
              continue;
            }

            const options = Array.isArray(q.options)
              ? q.options.map((opt: any) => ({
                  text: String(opt.text ?? opt.option ?? '').trim(),
                  correct: Boolean(opt.correct ?? opt.isCorrect ?? false),
                  explanation: String(opt.explanation || opt.explaination || '').trim(),
                }))
              : [];

            // Validate: must have 4 options and at least 1 correct
            if (options.length < 2) {
              console.warn(
                `[generateQuestions] Skipping question with < 2 options: "${questionText.slice(0, 50)}"`
              );
              continue;
            }

            allQuestions.push({
              questionText,
              options,
              solution:
                typeof q.solution === 'string'
                  ? q.solution
                  : typeof q.solution?.text === 'string'
                  ? q.solution.text
                  : '',
              isParameterized: Boolean(q.isParameterized ?? q.question?.isParameterized ?? false),
              timeLimitSeconds: Number(q.timeLimitSeconds ?? q.question?.timeLimitSeconds ?? 60),
              points: Number(q.points ?? q.question?.points ?? 5),
              segmentId,
              questionType: type,
            });
            addedCount++;
          }

          console.log(
            `[generateQuestions] Added ${addedCount}/${count} ${type} questions from segment "${segmentId}"`
          );
        } catch (err: any) {
          console.error(
            `[generateQuestions] Failed for type "${type}", segment "${segmentId}": ${err.message}`
          );
          // Don't throw — try remaining segments/types
        }
      }
    }

    console.log(`[generateQuestions] Total questions generated: ${allQuestions.length}`);

    if (allQuestions.length === 0) {
      throw new InternalServerError(
        'No questions were generated. Possible causes: ' +
          '(1) AI API key is invalid or quota exceeded — check OPENAI_API_KEY and GEMINI_API_KEY in .env, ' +
          '(2) Content was too short or unclear for question generation, ' +
          '(3) AI response was unparseable JSON. Check server logs for details.'
      );
    }

    return allQuestions;
  }
}