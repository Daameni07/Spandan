import { useState } from "react";
import { Plus, Trash2, Check, Edit3, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

export interface ManualQuestion {
  question: string;
  options: string[];
  correctOptionIndex: number;
}

interface ManualQuestionFormProps {
  /** Called when teacher clicks "Add Question" — adds to the generated questions list */
  onAddQuestion: (q: ManualQuestion) => void;
  /** Whether the voice transcript is available (teacher has spoken) */
  hasTranscript: boolean;
}

const emptyQuestion = (): ManualQuestion => ({
  question: "",
  options: ["", "", "", ""],
  correctOptionIndex: 0,
});

export default function ManualQuestionForm({
  onAddQuestion,
  hasTranscript,
}: ManualQuestionFormProps) {
  const [q, setQ] = useState<ManualQuestion>(emptyQuestion());
  const [addedCount, setAddedCount] = useState(0);

  const updateOption = (i: number, val: string) => {
    const opts = [...q.options];
    opts[i] = val;
    setQ({ ...q, options: opts });
  };

  const addOption = () => {
    if (q.options.length >= 6) return;
    setQ({ ...q, options: [...q.options, ""] });
  };

  const removeOption = (i: number) => {
    if (q.options.length <= 2) {
      toast.error("Need at least 2 options");
      return;
    }
    const opts = q.options.filter((_, idx) => idx !== i);
    let newCorrect = q.correctOptionIndex;
    if (q.correctOptionIndex === i) newCorrect = 0;
    else if (q.correctOptionIndex > i) newCorrect = q.correctOptionIndex - 1;
    setQ({ ...q, options: opts, correctOptionIndex: newCorrect });
  };

  const validOptions = q.options.filter((o) => o.trim() !== "");

  const handleAdd = () => {
    if (!q.question.trim()) {
      toast.error("Please enter a question");
      return;
    }
    if (validOptions.length < 2) {
      toast.error("Please enter at least 2 options");
      return;
    }
    if (!q.options[q.correctOptionIndex]?.trim()) {
      toast.error("Please mark a valid correct answer");
      return;
    }

    // Pass only non-empty options, re-map correct index
    const filledOptions = q.options.map((o) => o.trim()).filter((o) => o !== "");
    const correctText = q.options[q.correctOptionIndex]?.trim();
    const newCorrectIndex = filledOptions.indexOf(correctText ?? "");

    onAddQuestion({
      question: q.question.trim(),
      options: filledOptions,
      correctOptionIndex: newCorrectIndex >= 0 ? newCorrectIndex : 0,
    });

    setAddedCount((c) => c + 1);
    setQ(emptyQuestion());
    toast.success("Question added! You can add more or click 'Generated Questions' to review.");
  };

  return (
    <div className="space-y-5 p-4 border border-blue-200 dark:border-blue-900/60 rounded-xl bg-blue-50/40 dark:bg-blue-950/20">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Edit3 className="w-4 h-4 text-blue-600 dark:text-blue-400" />
          <span className="text-sm font-semibold text-blue-700 dark:text-blue-300">
            Write Your Question
          </span>
        </div>
        {addedCount > 0 && (
          <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 px-2.5 py-1 rounded-full">
            <CheckCircle2 className="w-3 h-3" />
            {addedCount} question{addedCount > 1 ? "s" : ""} added
          </div>
        )}
      </div>

      {!hasTranscript && (
        <div className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
          💡 Tip: Record your voice first, then write questions based on what you spoke.
        </div>
      )}

      {/* Question Input */}
      <div>
        <label className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1.5 block uppercase tracking-wide">
          Question
        </label>
        <Input
          placeholder="Type your question here..."
          value={q.question}
          onChange={(e) => setQ({ ...q, question: e.target.value })}
          className="text-sm bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600"
        />
      </div>

      {/* Options */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400 uppercase tracking-wide">
            Answer Options{" "}
            <span className="normal-case text-gray-400 dark:text-gray-500">
              — click radio to mark correct
            </span>
          </label>
          <Button
            variant="ghost"
            size="sm"
            onClick={addOption}
            disabled={q.options.length >= 6}
            className="h-6 text-xs text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-900/30 px-2"
          >
            <Plus className="w-3 h-3 mr-1" />
            Add Option
          </Button>
        </div>

        <div className="space-y-2">
          {q.options.map((opt, i) => {
            const isCorrect = q.correctOptionIndex === i;
            return (
              <div key={i} className="flex items-center gap-2">
                {/* Radio */}
                <input
                  type="radio"
                  name="correct-option"
                  checked={isCorrect}
                  onChange={() => setQ({ ...q, correctOptionIndex: i })}
                  className="accent-blue-600 h-4 w-4 flex-shrink-0 cursor-pointer"
                  title="Mark as correct answer"
                />

                {/* Option input */}
                <Input
                  placeholder={`Option ${i + 1}`}
                  value={opt}
                  onChange={(e) => updateOption(i, e.target.value)}
                  className={`text-sm flex-1 bg-white dark:bg-gray-900 transition-colors ${
                    isCorrect
                      ? "border-green-400 dark:border-green-600 bg-green-50/60 dark:bg-green-900/20 text-green-800 dark:text-green-200"
                      : "border-gray-300 dark:border-gray-600"
                  }`}
                />

                {/* Correct badge */}
                {isCorrect ? (
                  <div className="flex items-center gap-1 text-green-600 dark:text-green-400 flex-shrink-0 min-w-[60px]">
                    <Check className="w-3.5 h-3.5" />
                    <span className="text-xs font-medium">Correct</span>
                  </div>
                ) : (
                  <div className="min-w-[60px]" />
                )}

                {/* Remove */}
                {q.options.length > 2 && (
                  <button
                    onClick={() => removeOption(i)}
                    className="text-gray-300 hover:text-red-500 dark:text-gray-600 dark:hover:text-red-400 flex-shrink-0 transition-colors"
                    title="Remove option"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
          The option with the filled radio button is marked as the correct answer for students.
        </p>
      </div>

      {/* Add Button */}
      <Button
        onClick={handleAdd}
        disabled={!q.question.trim() || validOptions.length < 2}
        className="w-full bg-blue-600 hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-600 text-white font-medium"
      >
        <Plus className="w-4 h-4 mr-2" />
        Add to Questions List
      </Button>

      <p className="text-xs text-center text-gray-400 dark:text-gray-500">
        Added questions appear in{" "}
        <span className="text-purple-500 font-medium">Generated Questions</span> — review and launch them as polls from there.
      </p>
    </div>
  );
}