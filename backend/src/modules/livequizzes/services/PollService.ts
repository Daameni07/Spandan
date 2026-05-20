import { injectable, inject } from 'inversify';
import crypto from 'crypto';
import { Room } from '../../../shared/database/models/Room.js';
import { pollSocket } from '../utils/PollSocket.js';
import { UserModel } from '#root/shared/database/models/User.js';
import { evaluateBadges } from '../utils/achievementEngine.js';
import UserAchievement from '#root/shared/database/models/UserAchievement.js';
import Badge from '#root/shared/database/models/Badge.js';
import { updateRoomStats } from '../utils/statsService.js';
import { calculateScore } from '../utils/calculateScore.js';
import { BadRequestError, NotFoundError } from 'routing-controllers';

interface InMemoryPoll {
  pollId: string;
  question: string;
  options: string[];
  correctOptionIndex: number;
  responses: Record<string, number>; // optionIndex: count
  totalResponses: number;
  userResponses: Map<string, number>; // userId: optionIndex
  timer: number;
  startTime?: number;
  timeLeft: number;
  roomCode: string;
  createdAt?: Date;
  lockedActiveUsers?: string[];
  maxPoints?: number;
}

@injectable()
export class PollService {
  private pollSocket = pollSocket;
  private activePolls = new Map<string, InMemoryPoll>(); // pollId -> InMemoryPoll
  private pollTimers = new Map<string, NodeJS.Timeout>(); // pollId -> timer

  async createPoll(roomCode: string, data: {
    question: string;
    options: string[];
    correctOptionIndex: number;
    timer?: number;
    maxPoints?: number;
  }) {
    const question = String(data.question ?? '').trim();
    if (!question) {
      throw new BadRequestError('Poll question is required');
    }

    const options = Array.isArray(data.options)
      ? data.options.map((opt) => String(opt).trim()).filter((opt) => opt !== '')
      : [];

    if (options.length < 2) {
      throw new BadRequestError('At least two poll options are required');
    }

    const correctOptionIndex = Number.isInteger(data.correctOptionIndex) && data.correctOptionIndex >= 0 && data.correctOptionIndex < options.length
      ? data.correctOptionIndex
      : 0;

    const timer = data.timer !== undefined ? Math.max(0, Math.min(data.timer, 300)) : 30;
    const maxPoints = data.maxPoints !== undefined ? Math.max(1, data.maxPoints) : 20;

    const pollId = crypto.randomUUID();
    const createdAt = new Date();
    const lockedActiveUsers: string[] = pollSocket.getActiveUsersInRoom(roomCode);
    const poll = {
      _id: pollId,
      question,
      options,
      correctOptionIndex,
      timer,
      maxPoints,
      createdAt,
      lockedActiveUsers,
      answers: []
    };

    const livepoll: InMemoryPoll = {
      pollId,
      question,
      options,
      correctOptionIndex,
      responses: {},
      totalResponses: 0,
      userResponses: new Map(),
      timer,
      timeLeft: timer,
      roomCode,
      createdAt,
      lockedActiveUsers: [...lockedActiveUsers],
      maxPoints,
    };

    const updateResult = await Room.updateOne(
      { roomCode },
      { $push: { polls: poll } }
    );

    if (updateResult.matchedCount === 0) {
      throw new NotFoundError('Room not found');
    }

    this.activePolls.set(pollId, livepoll);

    pollSocket.emitToRoom(roomCode, 'new-poll', poll);
    return poll;
  }



  async submitAnswer(roomCode: string, pollId: string, userId: string, answerIndex: number) {

    const poll = this.activePolls.get(pollId);
    if (!poll || poll.roomCode !== roomCode) {
      throw new Error('Poll not found or invalid room');
    }

    // Update in-memory response tracking
    const previousResponse = poll.userResponses.get(userId);

    // If user already answered, decrement previous response count
    if (previousResponse !== undefined) {
      const prevOption = previousResponse.toString();
      poll.responses[prevOption] = (poll.responses[prevOption] || 1) - 1;
      poll.totalResponses--;
    }

    // Update new response
    poll.userResponses.set(userId, answerIndex);
    const optionKey = answerIndex.toString();
    poll.responses[optionKey] = (poll.responses[optionKey] || 0) + 1;
    poll.totalResponses++;

    // Emit update to all clients
    this.emitPollUpdate(roomCode, pollId);

    const answeredAt = new Date();

    // Determine correctness
    const isCorrect = poll.correctOptionIndex === answerIndex;

    // Calculate response time (seconds)
    const responseTime = (answeredAt.getTime() - poll.createdAt.getTime()) / 1000;

    const points = calculateScore({
      isCorrect,
      responseTime,
      maxPoints: poll?.maxPoints,
      timer: poll.timer
    });

    await Room.updateOne(
      { roomCode, "polls._id": pollId },
      { $push: { "polls.$.answers": { userId, answerIndex, answeredAt, points } } }
    );



    // Update room stats
    const stats = await updateRoomStats({
      userId,
      roomCode,
      isCorrect,
      responseTime,
      points,
    });

    // Evaluate badges and notify room in real time when unlocked
    const newlyUnlockedBadges = await evaluateBadges(userId, roomCode, stats);
    if (newlyUnlockedBadges.length > 0) {
      pollSocket.emitToRoom(roomCode, 'badge-earned', {
        userId,
        roomCode,
        badges: newlyUnlockedBadges,
      });
    }
  }

  async getPollResults(roomCode: string) {
    const room = await Room.findOne({ roomCode });
    if (!room) return null;

    const results: Record<string, Record<string, { count: number; users: { id: string; name: string }[] }>> = {};

    for (const poll of room.polls) {
      const counts = Array(poll.options.length).fill(0);
      const userIds = poll.options.map(() => [] as string[]);

      for (const ans of poll.answers) {
        if (ans.answerIndex >= 0 && ans.answerIndex < poll.options.length) {
          counts[ans.answerIndex]++;
          userIds[ans.answerIndex].push(ans.userId);
        }
      }
      const allUserIds = [...new Set(poll.answers.map(ans => ans.userId))];
      const users = await UserModel.find({ firebaseUID: { $in: allUserIds } }, { firebaseUID: 1, firstName: 1, lastName: 1 });
      const userMap = new Map(users.map(user => {
        const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Unknown User';
        return [user.firebaseUID, { id: user.firebaseUID, name: fullName }];
      }));

      const pollResult = poll.options.reduce((acc, opt, i) => {
        const usersForOption = userIds[i].map(userId => {
          const user = userMap.get(userId);
          return user || { id: userId, name: 'Unknown User' };
        });
        acc[opt] = {
          count: counts[i],
          users: usersForOption
        };
        return acc;
      }, {} as Record<string, { count: number; users: { id: string; name: string }[] }>);

      results[poll.question] = pollResult;
    }

    return results;
  }


  private emitPollUpdate(roomCode: string, pollId: string) {
    const poll = this.activePolls.get(pollId);
    if (!poll) return;

    const pollData = this.getPollData(poll);

    // Emit to all clients in the room
    // console.log(`[POLL Service]Emitting in-memory-poll-update for room ${roomCode}:`, pollData);
    this.pollSocket.emitToRoom(roomCode, 'live-poll-results', pollData);
  }

  private getPollData(poll: InMemoryPoll) {
    // Calculate correct percentage
    const correctResponses = poll.responses[poll.correctOptionIndex] || 0;
    const correctPercentage = poll.totalResponses > 0
      ? Math.round((correctResponses / poll.totalResponses) * 100)
      : 0;

    // Convert userResponses Map to plain object
    const userResponses = Object.fromEntries(poll.userResponses);

    return {
      pollId: poll.pollId,
      question: poll.question,
      options: poll.options,
      correctOptionIndex: poll.correctOptionIndex,
      responses: { ...poll.responses },
      totalResponses: poll.totalResponses,
      timeLeft: poll.timeLeft,
      timer: poll.timer,
      correctPercentage,
      userResponses,
      roomCode: poll.roomCode,
    };
  }

 async getUserAchievements(userId: string) {
  const [achievedBadgesRaw, allBadges] = await Promise.all([
    UserAchievement.find({ userId })
      .populate("badgeId")
      .lean(),
    Badge.find().lean()
  ]);

  const achievedBadges = achievedBadgesRaw.filter((a: any) => a?.badgeId?._id);
  const achievedBadgeIds = new Set(
    achievedBadges.map((a: any) => a.badgeId._id.toString())
  );

  const unachievedBadges = allBadges.filter(
    badge => !achievedBadgeIds.has(badge._id.toString())
  );

  return { achievedBadges, unachievedBadges };
}

}
