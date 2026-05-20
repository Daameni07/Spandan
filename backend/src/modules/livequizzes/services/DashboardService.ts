import { injectable } from 'inversify';
import { Room } from '../../../shared/database/models/Room.js';
import UserAchievement from '#root/shared/database/models/UserAchievement.js';
import Badge from '#root/shared/database/models/Badge.js';
import UserRoomStats from '#root/shared/database/models/UserRoomStats.js';

@injectable()
export class DashboardService {
    async getStudentDashboardData(studentId: string) {
        const joinedRooms = await Room.find({ joinedStudents: studentId }).lean();
        const userAchievements = await UserAchievement.find({ userId: studentId }).populate('badgeId').lean();
        const allBadges = await Badge.find().lean();

        const earnedBadgeIds = new Set(userAchievements.map((achievement: any) => achievement.badgeId?._id?.toString() || achievement.badgeId?.toString()));
        const badgeCountByRoom: Record<string, number> = {};
        userAchievements.forEach((achievement: any) => {
            if (achievement.roomCode) {
                badgeCountByRoom[achievement.roomCode] = (badgeCountByRoom[achievement.roomCode] || 0) + 1;
            }
        });

        const nextBadge = allBadges
            .filter((badge) => !earnedBadgeIds.has(badge._id.toString()))
            .sort((a, b) => (a.rule?.threshold ?? 0) - (b.rule?.threshold ?? 0))[0] || null;

        let totalPolls = 0;
        let takenPolls = 0;
        let absentPolls = 0;
        let unattemptedPolls = 0;
        let totalScore = 0;
        let totalMaxPoints = 0;
        let responseTimes: number[] = [];

        let pollResults: any[] = [];
        let pollDetails: any[] = [];
        let activePolls: any[] = [];
        let upcomingPolls: any[] = [];
        let scoreProgression: any[] = [];
        let roomWiseScores: any[] = [];
        let questionHistory: any[] = [];
        let sessionAnalytics: any[] = [];

        for (const room of joinedRooms) {
            let roomScore = 0;
            let roomMaxPoints = 0;
            let attendedPolls = 0;
            let roomUnattemptedPolls = 0;
            let roomAbsentPolls = 0;
            let roomResponseTimes: number[] = [];

            for (const poll of room.polls ?? []) {
                totalPolls++;
                const answer = poll.answers?.find((a: any) => a.userId === studentId);
                const maxPoints = poll.maxPoints ?? 20;
                const questionText = poll.question || 'Untitled Poll';
                const createdAt = poll.createdAt ? new Date(poll.createdAt) : new Date();
                const answeredAt = answer?.answeredAt ? new Date(answer.answeredAt) : null;
                const responseTime = answeredAt ? Math.max(0, Math.round((answeredAt.getTime() - createdAt.getTime()) / 1000)) : null;

                if (answer) {
                    takenPolls++;
                    attendedPolls++;
                    const score = answer.points ?? 0;
                    roomScore += score;
                    roomMaxPoints += maxPoints;
                    totalScore += score;
                    totalMaxPoints += maxPoints;
                    if (responseTime !== null) {
                        responseTimes.push(responseTime);
                        roomResponseTimes.push(responseTime);
                    }

                    pollResults.push({
                        name: questionText,
                        score,
                        maxPoints,
                        points: answer.points ?? 0,
                        date: createdAt
                    });

                    scoreProgression.push({
                        poll: questionText,
                        score: answer.points ?? 0,
                        maxPoints
                    });
                } else {
                    const wasPresent = (poll.lockedActiveUsers ?? []).includes(studentId);
                    if (!wasPresent) {
                        absentPolls++;
                        roomAbsentPolls++;
                    } else {
                        unattemptedPolls++;
                        roomUnattemptedPolls++;
                        roomMaxPoints += maxPoints;
                        totalMaxPoints += maxPoints;
                        pollResults.push({
                            name: questionText,
                            score: 0,
                            maxPoints,
                            points: 0,
                            date: createdAt
                        });

                        scoreProgression.push({
                            poll: questionText,
                            score: 0,
                            maxPoints
                        });
                    }
                }

                questionHistory.push({
                    pollId: poll._id,
                    roomName: room.name,
                    roomCode: room.roomCode,
                    question: questionText,
                    options: poll.options || [],
                    selectedAnswerIndex: answer?.answerIndex ?? null,
                    selectedAnswer: answer ? poll.options?.[answer.answerIndex] ?? null : null,
                    correctAnswerIndex: poll.correctOptionIndex ?? -1,
                    correctAnswer: poll.options?.[poll.correctOptionIndex] ?? 'N/A',
                    points: answer?.points ?? 0,
                    maxPoints,
                    isCorrect: answer ? answer.answerIndex === poll.correctOptionIndex : false,
                    answeredAt: answeredAt?.toISOString() || null,
                    responseTimeSeconds: responseTime,
                    answeredStatus: answer ? (answer.answerIndex === poll.correctOptionIndex ? 'correct' : 'incorrect') : ((poll.lockedActiveUsers ?? []).includes(studentId) ? 'unanswered' : 'absent'),
                    date: createdAt.toISOString()
                });

                pollDetails.push({
                    title: questionText,
                    type: 'MCQ',
                    timer: poll.timer?.toString() || 'N/A'
                });

                if (room.status === 'active') {
                    activePolls.push({
                        name: questionText,
                        status: 'Ongoing'
                    });
                }
            }

            if (attendedPolls > 0 || roomUnattemptedPolls > 0) {
                const avgScore = roomMaxPoints > 0 ? Math.round((roomScore / roomMaxPoints) * 100) : 0;
                const roomResponseAverage = roomResponseTimes.length > 0 ? Math.round(roomResponseTimes.reduce((sum, time) => sum + time, 0) / roomResponseTimes.length) : 0;
                sessionAnalytics.push({
                    roomName: room.name,
                    roomCode: room.roomCode,
                    totalPolls: room.polls.length,
                    taken: attendedPolls,
                    absent: roomAbsentPolls,
                    unattempted: roomUnattemptedPolls,
                    points: roomScore,
                    maxPoints: roomMaxPoints,
                    accuracy: roomMaxPoints > 0 ? `${Math.round((roomScore / roomMaxPoints) * 100)}%` : '0%',
                    avgResponseTime: roomResponseAverage ? `${roomResponseAverage}s` : 'N/A',
                    badgesEarned: badgeCountByRoom[room.roomCode] || 0,
                    status: room.status
                });

                roomWiseScores.push({
                    roomName: room.name,
                    roomCode: room.roomCode,
                    totalPolls: room.polls.length,
                    attendedPolls,
                    taken: attendedPolls,
                    score: roomScore,
                    maxPossiblePoints: roomMaxPoints,
                    avgScore,
                    averageScore: `${avgScore}%`,
                    status: room.status,
                    createdAt: room.createdAt
                });
            }
        }

        const avgScore = totalMaxPoints > 0 ? Math.round((totalScore / totalMaxPoints) * 100) : 0;
        const participationRate = totalPolls > 0 ? `${Math.round((takenPolls / totalPolls) * 100)}%` : '0%';
        const averageResponseTimeValue = responseTimes.length ? Math.round(responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length) : 0;
        const fastestResponseTime = responseTimes.length ? Math.min(...responseTimes) : 0;
        const slowestResponseTime = responseTimes.length ? Math.max(...responseTimes) : 0;

        // Sort question history by date in descending order (most recent first)
        questionHistory.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

        return {
            pollStats: {
                total: totalPolls,
                taken: takenPolls,
                absent: absentPolls,
                unattempted: unattemptedPolls,
                earnedPoints: totalScore
            },
            pollResults,
            pollDetails,
            activePolls,
            upcomingPolls,
            scoreProgression,
            questionHistory,
            sessionAnalytics,
            averageResponseTime: averageResponseTimeValue ? `${averageResponseTimeValue}s` : 'N/A',
            fastestResponseTime: fastestResponseTime ? `${fastestResponseTime}s` : 'N/A',
            slowestResponseTime: slowestResponseTime ? `${slowestResponseTime}s` : 'N/A',
            nextBadge: nextBadge ? {
                name: nextBadge.name,
                description: nextBadge.description,
                criteria: nextBadge.criteria,
                category: nextBadge.category
            } : null,
            performanceSummary: {
                avgScore: `${avgScore}%`,
                participationRate,
                bestSubject: 'N/A'
            },
            roomWiseScores
        };
    }

    async getTeacherDashboardData(teacherId: string) {
        const rooms = await Room.find({ teacherId }).lean();

        let totalPolls = 0;
        let totalResponses = 0;
        let activeRooms: any[] = [];
        let recentRooms: any[] = [];
        let responsesPerRoom: { roomName: string, totalResponses: number }[] = [];

        for (const room of rooms) {
            const pollCount = room.polls?.length || 0;
            const responseCount = room.polls?.reduce((sum, poll) => sum + (poll.answers?.length || 0), 0) || 0;
            const uniqueStudents = new Set(room.students?.map((s: any) => s.toString()) || []);
            const studentCount = uniqueStudents.size;

            totalPolls += pollCount;
            totalResponses += responseCount;

            const roomData = {
                roomName: room.name,
                roomCode: room.roomCode,
                createdAt: room.createdAt,
                status: room.status,
                totalPolls: pollCount,
                totalResponses: responseCount,
                totalStudents: studentCount,
            };

            if (room.status === 'active') {
                activeRooms.push(roomData);
            }

            recentRooms.push(roomData);

            responsesPerRoom.push({
                roomName: room.name,
                totalResponses: responseCount
            });
        }

        // Sort recentRooms and activeRooms by createdAt descending
        recentRooms.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        activeRooms.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        responsesPerRoom.sort((a, b) => b.totalResponses - a.totalResponses); // Optional: Sort descending

        const participationRate = totalPolls > 0 ? `${Math.round((totalResponses / totalPolls) * 100)}%` : '0%';

        return {
            summary: {
                totalAssessmentRooms: rooms.length,
                totalPolls,
                totalResponses,
                participationRate
            },
            activeRooms,
            recentRooms,
            responsesPerRoom,
            faqs: [
                { question: "How to create a room?", answer: "Click on 'Create Room' button from the dashboard." },
                { question: "How are scores calculated?", answer: "Each correct answer gives 20 points." }
            ]
        };
    }

    //get user achievement progress
    async getUserAchievementProgress(userId: string) {
        const [earnedBadgeIds, totalBadges] = await Promise.all([
            UserAchievement.distinct('badgeId', { userId }),
            Badge.countDocuments(),
        ]);

        const earned = earnedBadgeIds.length;
        const percent = totalBadges > 0 ? Math.round((earned / totalBadges) * 100) : 0;

        return {
            earned,
            total: totalBadges,
            percent,
        };
    }
}
