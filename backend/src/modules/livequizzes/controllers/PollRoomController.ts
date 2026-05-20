// backend/src/modules/livequizzes/controllers/PollRoomController.ts
// KEY FIX: All /cohost/* and static routes MUST come before /:code routes.
// routing-controllers processes decorators bottom-up in class, but Express
// registers them in declaration order — put specific routes first.

import {
  JsonController,
  Post,
  Get,
  Body,
  Param,
  QueryParam,
  HttpCode,
  Req,
  Res,
  NotFoundError,
  InternalServerError,
  BadRequestError,
  Patch,
} from 'routing-controllers';
import { Request, Response } from 'express';
import multer from 'multer';
import { pollSocket } from '../utils/PollSocket.js';
import { inject, injectable } from 'inversify';
import { Room } from '../../../shared/database/models/Room.js';
import { RoomService } from '../services/RoomService.js';
import { PollService } from '../services/PollService.js';
import { CreateRoomValidator } from '../validators/CreateRoomValidator.js';
import { CreatePollValidator } from '../validators/CreatePollValidator.js';
import { LIVE_QUIZ_TYPES } from '../types.js';
import { AIContentService } from '#root/modules/genai/services/AIContentService.js';
import { VideoService } from '#root/modules/genai/services/VideoService.js';
import { AudioService } from '#root/modules/genai/services/AudioService.js';
import { CleanupService } from '#root/modules/genai/services/CleanupService.js';
import type { QuestionSpec } from '#root/modules/genai/services/AIContentService.js';
import { OpenAPI } from 'routing-controllers-openapi';
import dotenv from 'dotenv';
import mime from 'mime-types';
import * as fsp from 'fs/promises';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();
const appOrigins = process.env.APP_ORIGINS;

declare module 'express-serve-static-core' {
  interface Request {
    file?: Express.Multer.File;
    files?: Express.Multer.File[];
  }
}

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedPrefixes = ['audio/', 'video/', 'text/'];
    const allowedExact = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];
    const allowed =
      allowedPrefixes.some(p => file.mimetype.startsWith(p)) ||
      allowedExact.includes(file.mimetype);
    cb(null, allowed);
  },
});

async function extractTextFromFile(filePath: string, mimeType: string): Promise<string> {
  if (mimeType.startsWith('text/')) return fsp.readFile(filePath, 'utf-8');
  if (mimeType === 'application/pdf') {
    const pdfParse = (await import('pdf-parse')).default;
    const data = await pdfParse(await fsp.readFile(filePath));
    return data.text;
  }
  if (
    mimeType === 'application/msword' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }
  throw new Error(`Unsupported file type: ${mimeType}`);
}

@injectable()
@OpenAPI({ tags: ['Rooms'] })
@JsonController('/livequizzes/rooms')
export class PollRoomController {
  constructor(
    @inject(LIVE_QUIZ_TYPES.VideoService) private videoService: VideoService,
    @inject(LIVE_QUIZ_TYPES.AudioService) private audioService: AudioService,
    @inject(LIVE_QUIZ_TYPES.AIContentService) private aiContentService: AIContentService,
    @inject(LIVE_QUIZ_TYPES.CleanupService) private cleanupService: CleanupService,
    @inject(LIVE_QUIZ_TYPES.RoomService) private roomService: RoomService,
    @inject(LIVE_QUIZ_TYPES.PollService) private pollService: PollService,
  ) {}

  // ═══════════════════════════════════════════════════════════
  // ✅ SECTION 1: STATIC-PREFIX ROUTES (must be declared first)
  // ═══════════════════════════════════════════════════════════

  @Post('/')
  async createRoom(@Body() body: CreateRoomValidator) {
    console.log('📦 createRoom body received:', body);
    if (!body || typeof body !== 'object') {
      throw new BadRequestError('Invalid request payload');
    }
    const room = await this.roomService.createRoom(body.name.trim(), body.teacherId.trim());
    return {
      ...room,
      inviteLink: `${appOrigins ?? ''}/student/pollroom/${room.roomCode}`,
    };
  }

  // ── Co-host routes ────────────────────────────────────────

  @Post('/cohost')
  async joinAsCohost(@Body() body: { token: string; userId: string }) {
    try {
      const resp = await this.roomService.joinAsCohost(body.token, body.userId);
      return { success: true, ...resp };
    } catch (error: any) {
      console.error('❌ Controller error:', error);
      return { success: false, message: error?.message || 'Something went wrong' };
    }
  }

  @Post('/cohost/:code')
  async generateCohostInvite(
    @Param('code') roomCode: string,
    @Body() body: { userId: string }
  ) {
    try {
      const inviteLink = await this.roomService.generateCohostInvite(roomCode, body.userId);
      return { success: true, inviteLink };
    } catch (error: any) {
      throw new BadRequestError(error.message || 'Failed to generate invite');
    }
  }

  @Get('/cohost/:userId')
  async getCohostRooms(@Param('userId') userId: string) {
    try {
      const resp = await this.roomService.getCohostedRooms(userId);
      return { success: true, ...resp };
    } catch {
      return { success: false, rooms: [], count: 0 };
    }
  }

  @Get('/cohost/:host/:code')
  async getRoomCohosts(
    @Param('host') host: string,
    @Param('code') roomCode: string
  ) {
    try {
      const activeCohosts = await this.roomService.getRoomCohosts(host, roomCode);
      return { success: true, activeCohosts };
    } catch {
      return { success: false, activeCohosts: [] };
    }
  }

  @Patch('/cohost/:code/mic')
  async toggleCohostMic(
    @Param('code') roomCode: string,
    @Body() body: { userId: string; teacherId: string; isMicMuted: boolean }
  ) {
    try {
      const resp = await this.roomService.setCohostMicMuted(
        roomCode, body.teacherId, body.userId, body.isMicMuted
      );
      return { success: true, ...resp };
    } catch (error: any) {
      throw new BadRequestError(error.message || 'Failed to toggle mic');
    }
  }

  @Patch('/cohost/:code')
  async removeCohost(
    @Param('code') roomCode: string,
    @Body() body: { userId: string; teacherId: string }
  ) {
    try {
      const resp = await this.roomService.removeCohost(roomCode, body.userId, body.teacherId);
      return { success: true, ...resp };
    } catch (error: any) {
      throw new BadRequestError(error.message || 'Failed to remove cohost');
    }
  }

  // ── Teacher listing routes ─────────────────────────────────

  @Get('/teacher/:teacherId/active')
  async getActiveRoomsByTeacher(@Param('teacherId') teacherId: string) {
    try {
      const rooms = await this.roomService.getRoomsByTeacherAndStatus(teacherId, 'active');
      return { success: true, rooms };
    } catch {
      return { success: false, rooms: [] };
    }
  }

  @Get('/teacher/:teacherId/ended')
  async getEndedRoomsByTeacher(@Param('teacherId') teacherId: string) {
    try {
      const rooms = await this.roomService.getRoomsByTeacherAndStatus(teacherId, 'ended');
      return { success: true, rooms };
    } catch {
      return { success: false, rooms: [] };
    }
  }

  @Get('/teacher/:teacherId')
  async getAllRoomsByTeacher(@Param('teacherId') teacherId: string) {
    try {
      const rooms = await this.roomService.getRoomsByTeacher(teacherId);
      return { success: true, rooms };
    } catch {
      return { success: false, rooms: [] };
    }
  }

  // ── Achievement route ──────────────────────────────────────

  @Get('/achievement/:userId')
  async getUserAchievements(@Param('userId') userId: string) {
    try {
      return await this.pollService.getUserAchievements(userId);
    } catch {
      return { success: false, achievements: [] };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // ✅ SECTION 2: /:code ROUTES (declared after all static routes)
  // ═══════════════════════════════════════════════════════════

  @Get('/:code')
  async getRoom(
    @Param('code') code: string,
    @QueryParam('userId') userId?: string,
    @QueryParam('role') role?: string,
  ) {
    try {
      const room = await this.roomService.getRoomByCode(code);
      if (!room) return { success: false, message: 'Room not found' };
      if (room.status !== 'active') return { success: false, message: 'Room is ended' };
      if (role === 'teacher') {
        if (!userId) return { success: false, message: 'User id is required' };
        const hasAccess =
          room.teacherId === userId ||
          room.coHosts?.some(c => c.userId === userId && c.isActive);
        if (!hasAccess) return { success: false, message: 'You do not have access to this room' };
      }
      return { success: true, room };
    } catch (error: any) {
      console.error('❌ getRoom error:', error);
      return { success: false, message: error?.message || 'Failed to fetch room' };
    }
  }

  @Get('/:roomId/analysis')
  async getPollAnalysis(@Param('roomId') roomId: string) {
    try {
      const analysis = await this.roomService.getPollAnalysis(roomId);
      return { success: true, data: analysis };
    } catch (error: any) {
      return { success: false, data: null, message: error.message };
    }
  }

  // ── Poll endpoints ─────────────────────────────────────────

  @Post('/:code/polls')
  async createPollInRoom(
    @Param('code') roomCode: string,
    @Body({ required: true }) body: CreatePollValidator
  ) {
    try {
      const room = await this.roomService.getRoomByCode(roomCode);
      if (!room) throw new NotFoundError('Room not found');

      const normalizedOptions = Array.isArray(body.options)
        ? body.options.map((opt) => String(opt).trim()).filter((opt) => opt !== '')
        : [];

      if (normalizedOptions.length < 2) {
        throw new BadRequestError('At least two poll options are required');
      }

      const correctOptionIndex = Math.min(
        Math.max(body.correctOptionIndex ?? 0, 0),
        normalizedOptions.length - 1
      );

      const poll = await this.pollService.createPoll(roomCode, {
        question: String(body.question).trim(),
        options: normalizedOptions,
        correctOptionIndex,
        timer: body.timer ?? 30,
        maxPoints: body.maxPoints ?? 20,
      });

      return { success: true, poll };
    } catch (error: any) {
      console.error('❌ createPollInRoom error:', error?.message || error);
      if (error instanceof NotFoundError || error instanceof BadRequestError) {
        throw error;
      }
      throw new InternalServerError(error?.message || 'Failed to create poll');
    }
  }

  // @Post('/:code/polls/answer')
  // async submitPollAnswer(
  //   @Param('code') roomCode: string,
  //   @Body() body: { pollId: string; userId: string; answerIndex: number }
  // ) {
  //   await this.pollService.submitAnswer(roomCode, body.pollId, body.userId, body.answerIndex);
  //   const updatedResults = await this.pollService.getPollResults(roomCode);
  //   pollSocket.emitToRoom(roomCode, 'poll-results-updated', updatedResults);
  //   return { success: true };
  // }
  @Post('/:code/polls/answer')
async submitPollAnswer(
  @Param('code') roomCode: string,
  @Body() body: { pollId: string; userId: string; answerIndex: number }
) {
  try {
    await this.pollService.submitAnswer(roomCode, body.pollId, body.userId, body.answerIndex);
    const updatedResults = await this.pollService.getPollResults(roomCode);
    pollSocket.emitToRoom(roomCode, 'poll-results-updated', updatedResults);
    return { success: true };
  } catch (error: any) {
    console.error('❌ Controller error:', error);
    return { success: false, message: error?.message || 'Something went wrong' };
  }
}

  @Get('/:code/polls/results')
  async getResultsForRoom(@Param('code') code: string) {
    try {
      return await this.pollService.getPollResults(code);
    } catch {
      return {};
    }
  }

  // ── Room control endpoints ─────────────────────────────────

  @Post('/:code/end')
  async endRoom(@Param('code') code: string, @Body() body: { teacherId: string }) {
    const success = await this.roomService.endRoom(code, body.teacherId);
    if (!success) throw new BadRequestError('Room not found or unauthorized');
    pollSocket.emitToRoom(code, 'room-ended', { message: 'Room has been ended by the host' });
    return { success: true, message: 'Room ended successfully' };
  }

  @Patch('/:code/controls')
  async updateRoomControls(
    @Param('code') roomCode: string,
    @Body() body: { userId: string; micBlocked?: boolean; pollRestricted?: boolean }
  ) {
    const updatedRoom = await this.roomService.updateRoomControls(roomCode, body.userId, {
      micBlocked: body.micBlocked,
      pollRestricted: body.pollRestricted,
    });

    const mode =
      body.micBlocked === true ? 'mic-disabled' :
      body.pollRestricted === true ? 'poll-disabled' : 'full';

    pollSocket.emitToRoom(roomCode, 'room-control-updated', { mode, controls: updatedRoom?.controls });
    return { success: true, mode, controls: updatedRoom?.controls };
  }

  @Patch('/:code/auto-generation')
  async toggleAutoGeneration(
    @Param('code') roomCode: string,
    @Body() body: { userId: string; paused: boolean }
  ) {
    const room = await this.roomService.getRoomByCode(roomCode);
    if (!room) throw new NotFoundError('Room not found');
    if (room.teacherId !== body.userId) throw new BadRequestError('Only host can control this');

    const updatedRoom = await this.roomService.updateRoomControls(roomCode, body.userId, {
      micBlocked: room.controls?.micBlocked ?? false,
      pollRestricted: room.controls?.pollRestricted ?? false,
      autoGenerationPaused: body.paused,
    });

    pollSocket.emitToRoom(roomCode, 'auto-generation-updated', {
      paused: body.paused,
      mode: body.paused ? 'manual' : 'auto',
    });

    return { success: true, paused: body.paused, controls: updatedRoom?.controls };
  }

  // ── Recording lock endpoints ───────────────────────────────
  // KEY FIX: These NEVER throw — always return JSON success/failure.
  // A thrown error becomes a 500; returned objects become 200 with success:false.

  @Post('/:code/recording/start')
  async startRecording(
    @Param('code') roomCode: string,
    @Body() body: { userId: string; userName?: string }
  ) {
    console.log('🎙️ recording/start:', { roomCode, userId: body?.userId });
    try {
      // Guard: body might be missing or malformed
      if (!body || !body.userId) {
        return { success: false, message: 'userId is required' };
      }

      const result = await this.roomService.acquireRecordingLock(
        roomCode,
        body.userId,
        body.userName
      );

      if (result.success) {
        pollSocket?.emitToRoom(roomCode, 'recording-started', {
          userId: body.userId,
          userName: body.userName ?? '',
          lockedSince: new Date(),
        });
      }

      // Always return 200 with success flag — never throw
      return result;
    } catch (error: any) {
      console.error('❌ recording/start unexpected error:', error);
      // Return 200 with failure — do NOT throw (avoids 500)
      return {
        success: false,
        message: error?.message || 'Failed to start recording',
      };
    }
  }

  @Post('/:code/recording/stop')
  async stopRecording(
    @Param('code') roomCode: string,
    @Body() body: { userId: string }
  ) {
    console.log('🛑 recording/stop:', { roomCode, userId: body?.userId });
    try {
      if (!body || !body.userId) {
        return { success: false, message: 'userId is required' };
      }

      const result = await this.roomService.releaseRecordingLock(roomCode, body.userId);

      if (result.success) {
        pollSocket?.emitToRoom(roomCode, 'recording-stopped', { userId: body.userId });
      }

      // Always return 200 with success flag — never throw
      return result;
    } catch (error: any) {
      console.error('❌ recording/stop unexpected error:', error);
      return {
        success: false,
        message: error?.message || 'Failed to stop recording',
      };
    }
  }

  @Get('/:code/recording/status')
  async getRecordingStatus(@Param('code') roomCode: string) {
    try {
      return await this.roomService.getRecordingLockStatus(roomCode);
    } catch (error: any) {
      console.error('❌ recording/status error:', error);
      return { isLocked: false };
    }
  }

  // ── AI Question Generation ─────────────────────────────────

  @Post('/:code/generate-questions')
  @HttpCode(200)
  async generateQuestionsFromTranscript(
    @Req() req: Request,
    @Res() res: Response,
    @Body({ required: false }) body: any,
  ) {
    const roomCode = req.params.code;
    console.log('🤖 generate-questions for room:', roomCode);
    const tempPaths: string[] = [];

    const payload = body || {};

    // Run multer ONLY for multipart (file uploads)
    if (req.headers['content-type']?.includes('multipart/form-data')) {
      await new Promise<void>((resolve, reject) => {
        upload.single('file')(req, res, err => (err ? reject(err) : resolve()));
      });
    }

    try {
      const body = payload || req.body || {};
      let { transcript, questionSpec, model, questionCount } = body;

      console.log('📥 Body keys:', Object.keys(body));
      console.log('📏 Transcript length:', transcript?.length ?? 'MISSING');

      // ── Step 1: Extract transcript from uploaded file if present ──
      if (req.file) {
        const file = req.file as Express.Multer.File;
        tempPaths.push(file.path);

        const detectedMime =
          file.mimetype ||
          (mime.lookup(file.originalname) as string) ||
          'application/octet-stream';

        console.log('📁 File uploaded:', { name: file.originalname, mime: detectedMime });

        if (detectedMime.startsWith('audio/') || detectedMime.startsWith('video/')) {
          const whisperKey = process.env.OPENAI_API_KEY;
          if (!whisperKey?.startsWith('sk-')) {
            return res.status(400).json({
              success: false,
              message: 'Audio transcription needs OPENAI_API_KEY in .env (sk-...).',
            });
          }

          let audioFilePath = file.path;
          if (detectedMime.startsWith('video/')) {
            audioFilePath = await this.audioService.extractAudio(file.path);
            tempPaths.push(audioFilePath);
          }

          const FormData = (await import('form-data')).default;
          const axiosLib = (await import('axios')).default;
          const form = new FormData();
          form.append('file', fs.createReadStream(audioFilePath), {
            filename: path.basename(audioFilePath) + '.mp3',
            contentType: 'audio/mpeg',
          });
          form.append('model', 'whisper-1');
          form.append('response_format', 'text');

          const whisperResp = await axiosLib.post(
            'https://api.openai.com/v1/audio/transcriptions',
            form,
            {
              headers: { ...form.getHeaders(), Authorization: `Bearer ${whisperKey}` },
              timeout: 120000,
            }
          );
          transcript = whisperResp.data?.text || whisperResp.data || '';
          console.log('✅ Whisper transcript length:', transcript.length);
        } else {
          transcript = await extractTextFromFile(file.path, detectedMime);
          console.log('✅ Extracted text length:', transcript.length);
        }
      }

      // ── Step 2: Validate transcript ───────────────────────────────
      if (!transcript || typeof transcript !== 'string' || !transcript.trim()) {
        return res.status(400).json({
          success: false,
          message:
            'No content provided. Options: ' +
            '(1) Send {"transcript":"..."} in JSON body, ' +
            '(2) Upload a .txt/.pdf/.docx file, ' +
            '(3) Upload audio/video (needs OPENAI_API_KEY).',
        });
      }

      // ── Step 3: Config ────────────────────────────────────────────
      const selectedModel = model?.trim() || process.env.DEFAULT_AI_MODEL || 'gemini-1.5-flash';
      const numQuestions = questionCount ? parseInt(String(questionCount), 10) : 3;

      console.log('⚙️ Model:', selectedModel, '| Questions:', numQuestions);

      // ── Step 4: Parse questionSpec ────────────────────────────────
      let instructions: string | undefined;
      if (typeof questionSpec === 'string' && questionSpec.trim()) {
        const trimmed = questionSpec.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try { questionSpec = JSON.parse(trimmed); }
          catch { instructions = trimmed; questionSpec = undefined; }
        } else {
          instructions = trimmed;
          questionSpec = undefined;
        }
      }

      // ── Step 5: Segment if long ───────────────────────────────────
      const THRESHOLD = parseInt(process.env.TRANSCRIPT_SEGMENTATION_THRESHOLD || '6000', 10);
      let segments: Record<string, string>;

      if (transcript.length <= THRESHOLD) {
        segments = { full: transcript };
      } else {
        console.log(`📋 Long transcript (${transcript.length} chars), segmenting...`);
        segments = await this.aiContentService.segmentTranscript(transcript, selectedModel);
      }

      // ── Step 6: Build spec ────────────────────────────────────────
      let safeSpec: QuestionSpec[] = [{ SOL: numQuestions }];
      if (questionSpec && typeof questionSpec === 'object' && !Array.isArray(questionSpec)) {
        safeSpec = [questionSpec as QuestionSpec];
      } else if (Array.isArray(questionSpec) && questionSpec.length > 0) {
        safeSpec = questionSpec;
      }

      // ── Step 7: Generate ──────────────────────────────────────────
      const generatedQuestions = await this.aiContentService.generateQuestions({
        segments,
        globalQuestionSpecification: safeSpec,
        model: selectedModel,
        instructions,
      });

      console.log(`✅ Generated ${generatedQuestions.length} questions`);

      const persistedQuestions = generatedQuestions.map((q: any) => ({
        question: q.questionText || q.question || '',
        options: Array.isArray(q.options) ? q.options.map((opt: any) => opt.text || '') : [],
        correctOptionIndex: Array.isArray(q.options)
          ? Math.max(0, q.options.findIndex((opt: any) => !!opt.correct))
          : 0,
      }));

      if (persistedQuestions.length > 0) {
        await Room.findOneAndUpdate(
          { roomCode },
          { $push: { generatedQuestions: { $each: persistedQuestions } } },
          { new: true }
        );
      }

      return res.json({
        success: true,
        message: 'Questions generated successfully',
        transcriptPreview: transcript.substring(0, 200) + '...',
        segmentsCount: Object.keys(segments).length,
        totalQuestions: generatedQuestions.length,
        requestedQuestions: numQuestions,
        questions: generatedQuestions,
      });

    } catch (err: any) {
      console.error('❌ generate-questions error:', err.message);
      return res.status(err.status || 500).json({
        success: false,
        message: err.message || 'Failed to generate questions',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
      });
    } finally {
      await this.cleanupService.cleanup(tempPaths);
    }
  }
}