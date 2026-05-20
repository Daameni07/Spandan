import { Wand2, Edit3 } from "lucide-react";

export type QuestionMode = "auto" | "manual";

interface QuestionModeSwitchProps {
  mode: QuestionMode;
  onChange: (mode: QuestionMode) => void;
  isHost: boolean;
  disabled?: boolean;
}

export default function QuestionModeSwitch({
  mode,
  onChange,
  isHost,
  disabled = false,
}: QuestionModeSwitchProps) {
  if (!isHost) return null;

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
        Question Mode:
      </span>
      <div className="flex bg-gray-100 dark:bg-gray-800 rounded-full p-1 gap-1">
        <button
          onClick={() => !disabled && onChange("auto")}
          disabled={disabled}
          className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold transition-all duration-200 ${
            mode === "auto"
              ? "bg-white dark:bg-gray-700 text-purple-700 dark:text-purple-300 shadow-sm"
              : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
        >
          <Wand2 className="w-3 h-3" />
          Auto (AI)
        </button>
        <button
          onClick={() => !disabled && onChange("manual")}
          disabled={disabled}
          className={`flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold transition-all duration-200 ${
            mode === "manual"
              ? "bg-white dark:bg-gray-700 text-blue-700 dark:text-blue-300 shadow-sm"
              : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
        >
          <Edit3 className="w-3 h-3" />
          Manual
        </button>
      </div>
    </div>
  );
}