import { useState } from "react";
import { Plus, Trash2, Check, Clock, BarChart2, Wand2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

interface ManualQuestion {
  question: string;
  options: string[];
  correctOptionIndex: number;
  timer: number;
  maxPoints: number;
}

interface ManualQuestionPanelProps {
  roomCode: string;
  isHost: boolean;
  /** Called when teacher clicks "Launch Poll" with the manual question */
  onLaunch: (q: ManualQuestion) => Promise<void>;
  /** Whether poll creation is restricted by room controls */
  pollRestricted: boolean;
}

const emptyQuestion = (): ManualQuestion => ({
  question: "",
  options: ["", "", "", ""],
  correctOptionIndex: 0,
  timer: 30,
  maxPoints: 20,
});

export default function ManualQuestionPanel({
  isHost,
  onLaunch,
  pollRestricted,
}: ManualQuestionPanelProps) {
  const [q, setQ] = useState<ManualQuestion>(emptyQuestion());
  const [isLaunching, setIsLaunching] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [timerRef, setTimerRef] = useState<ReturnType<typeof setInterval> | null>(null);

  // Only host can create manual questions
  if (!isHost) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center text-gray-400 dark:text-gray-500">
        <Wand2 className="w-10 h-10 mb-3 opacity-40" />
        <p className="text-sm">Only the host can create manual questions.</p>
      </div>
    );
  }

  if (pollRestricted) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center text-gray-400 dark:text-gray-500">
        <Wand2 className="w-10 h-10 mb-3 opacity-40" />
        <p className="text-sm">Poll creation is currently restricted by room controls.</p>
      </div>
    );
  }

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
    if (q.options.length <= 2) { toast.error("Need at least 2 options"); return; }
    const opts = q.options.filter((_, idx) => idx !== i);
    const newCorrect = q.correctOptionIndex >= opts.length
      ? opts.length - 1
      : q.correctOptionIndex === i ? 0 : q.correctOptionIndex > i
        ? q.correctOptionIndex - 1 : q.correctOptionIndex;
    setQ({ ...q, options: opts, correctOptionIndex: newCorrect });
  };

  const validOptions = q.options.filter(o => o.trim() !== "");

  const handleLaunch = async () => {
    if (!q.question.trim()) { toast.error("Please enter a question"); return; }
    if (validOptions.length < 2) { toast.error("Please enter at least 2 options"); return; }
    if (!q.options[q.correctOptionIndex]?.trim()) { toast.error("Please select a valid correct answer"); return; }

    setIsLaunching(true);
    try {
      await onLaunch(q);
      setLaunched(true);

      // Start countdown
      let t = q.timer;
      setTimeLeft(t);
      const id = setInterval(() => {
        t--;
        setTimeLeft(t);
        if (t <= 0) {
          clearInterval(id);
          setTimeLeft(null);
          setLaunched(false);
          setQ(emptyQuestion()); // Reset for next question
          toast.info("Poll timer ended");
        }
      }, 1000);
      setTimerRef(id);
    } catch {
      toast.error("Failed to launch poll");
    } finally {
      setIsLaunching(false);
    }
  };

  const handleReset = () => {
    if (timerRef) clearInterval(timerRef);
    setLaunched(false);
    setTimeLeft(null);
    setQ(emptyQuestion());
  };

  return (
    <Card className="w-full bg-white dark:bg-gray-900 border border-slate-200 dark:border-gray-700 shadow">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Plus className="w-4 h-4 text-purple-500" />
          Manual Question
          {launched && (
            <span className="ml-auto flex items-center gap-1 text-green-600 dark:text-green-400 text-sm font-normal">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              Live · {timeLeft}s
            </span>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Question */}
        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1 block">
            Question
          </label>
          <Input
            placeholder="Type your question here..."
            value={q.question}
            onChange={e => setQ({ ...q, question: e.target.value })}
            disabled={launched}
            className="text-sm"
          />
        </div>

        {/* Options */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
              Options <span className="text-xs text-gray-400">(click radio to mark correct)</span>
            </label>
            {!launched && (
              <Button
                variant="ghost"
                size="sm"
                onClick={addOption}
                disabled={q.options.length >= 6}
                className="h-7 text-xs text-purple-600 hover:text-purple-700"
              >
                <Plus className="w-3 h-3 mr-1" /> Add Option
              </Button>
            )}
          </div>
          <div className="space-y-2">
            {q.options.map((opt, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="correct"
                  checked={q.correctOptionIndex === i}
                  onChange={() => setQ({ ...q, correctOptionIndex: i })}
                  disabled={launched}
                  className="accent-purple-600 h-4 w-4 flex-shrink-0"
                />
                <Input
                  placeholder={`Option ${i + 1}`}
                  value={opt}
                  onChange={e => updateOption(i, e.target.value)}
                  disabled={launched}
                  className={`text-sm flex-1 ${q.correctOptionIndex === i
                    ? "border-green-400 dark:border-green-600 bg-green-50 dark:bg-green-900/20"
                    : ""}`}
                />
                {q.correctOptionIndex === i && (
                  <Check className="w-4 h-4 text-green-500 flex-shrink-0" />
                )}
                {!launched && q.options.length > 2 && (
                  <button
                    onClick={() => removeOption(i)}
                    className="text-red-400 hover:text-red-600 flex-shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Timer + Points */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1 flex items-center gap-1">
              <Clock className="w-3 h-3" /> Timer (seconds)
            </label>
            <Input
              type="number"
              min={5}
              max={300}
              value={q.timer}
              onChange={e => setQ({ ...q, timer: Number(e.target.value) })}
              disabled={launched}
              className="text-sm"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1 block">
              Max Points
            </label>
            <Input
              type="number"
              min={1}
              value={q.maxPoints}
              onChange={e => setQ({ ...q, maxPoints: Number(e.target.value) })}
              disabled={launched}
              className="text-sm"
            />
          </div>
        </div>

        {/* Active Poll Progress */}
        {launched && timeLeft !== null && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400">
              <span>Poll Active</span>
              <span>{timeLeft}s remaining</span>
            </div>
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
              <div
                className="bg-gradient-to-r from-purple-500 to-blue-500 h-2 rounded-full transition-all duration-1000"
                style={{ width: `${(timeLeft / q.timer) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2 pt-1">
          {!launched ? (
            <Button
              onClick={handleLaunch}
              disabled={
                isLaunching ||
                !q.question.trim() ||
                validOptions.length < 2
              }
              className="flex-1 bg-gradient-to-r from-purple-500 to-blue-500 text-white hover:from-purple-600 hover:to-blue-600"
            >
              {isLaunching ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Launching...</>
              ) : (
                <><BarChart2 className="w-4 h-4 mr-2" />Launch Poll</>
              )}
            </Button>
          ) : (
            <Button
              onClick={handleReset}
              variant="outline"
              className="flex-1 border-gray-300 text-gray-600 hover:bg-gray-50"
            >
              Create Next Question
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}