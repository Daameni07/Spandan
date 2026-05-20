import { UserRoomStats } from "./achievementEngine.js";

type Rule = {
  type: string;
  threshold: number;
}

const MIN_ANSWERS_FOR_ACCURACY = 100;

export function checkRule(rule: Rule, stats: UserRoomStats): boolean {

  switch (rule.type) {
    case "correct_answers":
      return stats.correctAnswers >= rule.threshold;

    case "correct_streak":
      return stats.maxStreak >= rule.threshold;

    case "accuracy":
      return (
        stats.accuracy >= rule.threshold &&
        stats.totalAnswers >= MIN_ANSWERS_FOR_ACCURACY
      );

    case "questions_answered":
      return stats.totalAnswers >= rule.threshold;

    case "fast_response":
      return (
        stats.fastestResponse != null &&
        stats.fastestResponse <= rule.threshold
      );

    default:
      return false;

  }

}
