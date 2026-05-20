// backend/src/modules/livequizzes/services/RoomService.ts

import { injectable } from 'inversify';
import { Room } from '../../../shared/database/models/Room.js';
import type {
  Room as RoomType,
  Poll,
  PollAnswer,
  CohostJwtPayload,
  GetCohostRoom,
  ActiveCohost,
} from '../interfaces/PollRoom.js';
import { UserModel } from '../../../shared/database/models/User.js';
import { ObjectId } from 'mongodb';
import { HttpError, NotFoundError } from 'routing-controllers';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { pollSocket } from '../utils/PollSocket.js';

@injectable()
export class RoomService {
  private userModel = UserModel;
  private roomModel = Room;

  // ─── Helper: safe lock check ──────────────────────────────────────────────
  private isActiveLock(lock: any): boolean {
    if (lock === null || lock === undefined) return false;
    if (typeof lock !== 'object') return false;
    if (!lock.userId || typeof lock.userId !== 'string' || lock.userId.trim() === '') return false;
    if (!lock.expiresAt) return false;
    const expiresAt = lock.expiresAt instanceof Date ? lock.expiresAt : new Date(lock.expiresAt);
    if (isNaN(expiresAt.getTime())) return false;
    return expiresAt > new Date();
  }

  // ─── Room CRUD ────────────────────────────────────────────────────────────

  async createRoom(name: string, teacherId: string): Promise<RoomType> {
    const normalizedName = name?.trim();
    const normalizedTeacherId = teacherId?.trim();

    if (!normalizedName) throw new Error('Room name is required');
    if (!normalizedTeacherId) throw new Error('Teacher ID is required');

    const code = await this.generateUniqueRoomCode();
    const teacher = await this.userModel.findOne({ firebaseUID: normalizedTeacherId }).lean();
    const teacherName = teacher
      ? `${teacher.firstName ?? ''} ${teacher.lastName ?? ''}`.trim() || normalizedTeacherId
      : normalizedTeacherId;

    const newRoom = await this.roomModel.create({
      roomCode: code,
      name: normalizedName,
      teacherId: normalizedTeacherId,
      teacherName,
      createdAt: new Date(),
      status: 'active',
      polls: [],
      generatedQuestions: [],
      controls: { micBlocked: false, pollRestricted: false, autoGenerationPaused: false },
      coHosts: [],
      recordingLock: null,
    });

    return this.mapRoom(newRoom.toObject());
  }

  private async generateUniqueRoomCode(): Promise<string> {
    const maxAttempts = 8;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      const existingRoom = await this.roomModel.exists({ roomCode: code });
      if (!existingRoom) return code;
    }
    throw new Error('Unable to generate a unique room code. Please try again.');
  }

  async getRoomByCode(code: string): Promise<RoomType | null> {
    const room = await Room.findOne({ roomCode: code })
      .populate('students', 'firstName email')
      .lean();
    return room ? this.mapRoom(room) : null;
  }

  async getRoomsByTeacher(teacherId: string, status?: 'active' | 'ended'): Promise<RoomType[]> {
    const query: any = { teacherId };
    if (status) query.status = status;
    const rooms = await Room.find(query).sort({ createdAt: -1 }).lean();
    return rooms.map(room => this.mapRoom(room));
  }

  async getUsersByIds(userIds: string[]) {
    return await this.userModel.find({ uid: { $in: userIds } }, 'uid name').lean();
  }

  async getPollAnalysis(roomCode: string) {
    const room = await this.roomModel.findOne({ roomCode }).lean();
    if (!room) throw new Error('Room not found');

    const participantsMap = new Map<
      string,
      { userId: string; correct: number; wrong: number; score: number; timeTaken: number }
    >();

    if (room.students && room.students.length > 0) {
      const enrolledUsers = await this.userModel
        .find({ _id: { $in: room.students } }, 'firebaseUID')
        .lean();
      for (const user of enrolledUsers) {
        if (user.firebaseUID) {
          participantsMap.set(user.firebaseUID, {
            userId: user.firebaseUID,
            correct: 0,
            wrong: 0,
            score: 0,
            timeTaken: 0,
          });
        }
      }
    }

    for (const poll of room.polls) {
      for (const answer of poll.answers) {
        if (!participantsMap.has(answer.userId)) {
          participantsMap.set(answer.userId, {
            userId: answer.userId,
            correct: 0,
            wrong: 0,
            score: 0,
            timeTaken: 0,
          });
        }
        const participant = participantsMap.get(answer.userId)!;
        if (answer.answerIndex === poll.correctOptionIndex) {
          participant.correct += 1;
          participant.score += 5;
        } else {
          participant.wrong += 1;
          participant.score -= 2;
        }
        const answerTime =
          (answer.answeredAt.getTime() - poll.createdAt.getTime()) / 1000;
        participant.timeTaken += answerTime;
      }
    }

    const userIds = Array.from(participantsMap.keys());
    const users = await this.userModel
      .find({ firebaseUID: { $in: userIds } }, 'firebaseUID firstName')
      .lean();

    const participants = Array.from(participantsMap.values()).map(p => {
      const user = users.find(u => u.firebaseUID === p.userId);
      let timeDisplay = 'N/A';
      if (p.timeTaken > 0) {
        const totalSeconds = Math.round(p.timeTaken);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        timeDisplay = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
      }
      return {
        name: user?.firstName ?? 'Anonymous',
        score: p.score,
        correct: p.correct,
        wrong: p.wrong,
        timeTaken: timeDisplay,
      };
    });

    participants.sort((a, b) => b.score - a.score);

    const questions = room.polls.map(poll => ({
      text: poll.question,
      correctCount: poll.answers.filter(a => a.answerIndex === poll.correctOptionIndex).length,
    }));

    return {
      id: room._id,
      name: room.name,
      createdAt: room.createdAt,
      duration:
        room.endedAt && room.createdAt
          ? Math.ceil((room.endedAt.getTime() - room.createdAt.getTime()) / 60000) + ' mins'
          : 'N/A',
      participants,
      questions,
    };
  }

  async getRoomsByTeacherAndStatus(
    teacherId: string,
    status: 'active' | 'ended'
  ): Promise<RoomType[]> {
    const rooms = await Room.find({ teacherId, status }).lean();
    return rooms.map(room => this.mapRoom(room));
  }

  async isRoomValidAndHasAccess(
    code: string,
    userId: string
  ): Promise<{ isActive: boolean; hasAccess: boolean }> {
    const result = { isActive: true, hasAccess: false };
    const room = await Room.findOne({ roomCode: code }).lean();
    if (!room || room.status.toLowerCase() !== 'active') result.isActive = false;
    if (
      room &&
      (room.teacherId === userId ||
        room.coHosts?.some(coHost => coHost.userId === userId && coHost.isActive))
    ) {
      result.hasAccess = true;
    }
    return result;
  }

  async isRoomEnded(code: string): Promise<boolean> {
    const room = await Room.findOne({ roomCode: code }).lean();
    return room ? room.status === 'ended' : false;
  }

  async endRoom(code: string, teacherId: string): Promise<boolean> {
    const updated = await Room.findOneAndUpdate(
      { roomCode: code, teacherId },
      { status: 'ended', endedAt: new Date() },
      { new: true }
    ).lean();
    pollSocket?.emitToRoom(code, 'room-ended', { message: 'Room has ended' });
    return !!updated;
  }

  async canJoinRoom(code: string): Promise<boolean> {
    const room = await Room.findOne({ roomCode: code }).lean();
    return !!room && room.status === 'active';
  }

  async getAllRooms(): Promise<RoomType[]> {
    const rooms = await Room.find().lean();
    return rooms.map(room => this.mapRoom(room));
  }

  async getActiveRooms(): Promise<RoomType[]> {
    const rooms = await Room.find({ status: 'active' }).lean();
    return rooms.map(room => this.mapRoom(room));
  }

  async getEndedRooms(): Promise<RoomType[]> {
    const rooms = await Room.find({ status: 'ended' }).lean();
    return rooms.map(room => this.mapRoom(room));
  }

  private mapRoom(roomDoc: any): RoomType {
    return {
      roomCode: roomDoc.roomCode,
      name: roomDoc.name,
      teacherId: roomDoc.teacherId,
      createdAt: roomDoc.createdAt,
      endedAt: roomDoc.endedAt,
      status: roomDoc.status,
      students: roomDoc.students,
      totalStudents: new Set(
        roomDoc.students?.map((s: any) =>
          s._id ? s._id.toString() : s.toString()
        ) || []
      ).size,
      coHosts: roomDoc.coHosts || [],
      controls: roomDoc.controls || {
        micBlocked: false,
        pollRestricted: false,
        autoGenerationPaused: false,
      },
      recordingLock: roomDoc.recordingLock ?? null,
      polls: (roomDoc.polls || []).map(
        (p: any): Poll => ({
          _id: p._id.toString(),
          question: p.question,
          options: p.options,
          correctOptionIndex: p.correctOptionIndex,
          timer: p.timer,
          createdAt: p.createdAt,
          answers: (p.answers || []).map(
            (a: any): PollAnswer => ({
              userId: a.userId,
              answerIndex: a.answerIndex,
              answeredAt: a.answeredAt,
            })
          ),
        })
      ),
      generatedQuestions: (roomDoc.generatedQuestions || []).map((q: any) => ({
        question: q.question,
        options: q.options || [],
        correctOptionIndex: q.correctOptionIndex ?? 0,
      })),
    };
  }

  async enrollStudent(userId: string, roomCode: string, firebaseUID: string) {
    const room = await Room.findOne({ roomCode });
    if (!room) throw new NotFoundError('Room is not found');
    const userObjectId = new ObjectId(userId);
    const isAlreadyEnrolled = room.students.some(id => id.equals(userObjectId));
    if (isAlreadyEnrolled) return room;
    return await Room.findOneAndUpdate(
      { roomCode },
      { $addToSet: { students: userObjectId, joinedStudents: firebaseUID } },
      { new: true }
    );
  }

  async unEnrollStudent(userId: string, roomCode: string) {
    if (!userId) return;
    const room = await Room.findOne({ roomCode });
    if (!room) {
      return { success: false, message: 'Room not found' };
    }
    const userObjectId = new ObjectId(userId);
    const isAlreadyEnrolled = room.students.some(id => id.equals(userObjectId));
    if (!isAlreadyEnrolled) return room;
    return await Room.findOneAndUpdate(
      { roomCode },
      { $pull: { students: userObjectId } },
      { new: true }
    );
  }

  // ─── Recording Lock ───────────────────────────────────────────────────────

  async acquireRecordingLock(
    roomCode: string,
    userId: string,
    userName?: string
  ): Promise<{
    success: boolean;
    message: string;
    currentRecorder?: { userId: string; userName?: string };
  }> {
    console.log('🔒 acquireRecordingLock:', { roomCode, userId, userName });

    // Validate inputs up front
    if (!roomCode || typeof roomCode !== 'string' || roomCode.trim() === '') {
      return { success: false, message: 'Invalid room code' };
    }
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      console.error('❌ Invalid userId:', userId);
      return { success: false, message: 'Invalid user' };
    }

    try {
      // Use findOne (not findById) — roomCode is NOT the MongoDB _id
      const room = await Room.findOne({ roomCode: roomCode.trim() });
      if (!room) {
        console.error('❌ Room not found for roomCode:', roomCode);
        return { success: false, message: 'Room not found' };
      }

      // Check if user is a muted co-host
      const activeCohost = (room.coHosts ?? []).find(
        c =>
          c != null &&
          typeof c.userId === 'string' &&
          c.userId === userId &&
          c.isActive === true
      );
      if (activeCohost?.isMicMuted) {
        console.log('🔇 Mic muted by host for:', userId);
        return { success: false, message: 'Host has muted your microphone' };
      }

      // Read existing lock safely — use toObject() to unwrap Mongoose subdoc
      const rawLock = room.toObject().recordingLock ?? null;
      console.log('🔐 Existing lock from DB:', JSON.stringify(rawLock));

      if (this.isActiveLock(rawLock)) {
        const lockOwnerId = rawLock.userId as string;
        if (lockOwnerId !== userId) {
          const lockOwnerName = rawLock.userName || 'another user';
          console.log('🚫 Lock held by:', lockOwnerId);
          return {
            success: false,
            message: `Recording is in use by ${lockOwnerName}`,
            currentRecorder: { userId: lockOwnerId, userName: lockOwnerName },
          };
        }
        console.log('♻️ Same user re-acquiring lock');
      } else {
        console.log('🔓 No active lock — acquiring');
      }

      // Write the lock using updateOne with roomCode filter (not _id)
      const lockExpiresAt = new Date(Date.now() + 30 * 60 * 1000);
      const updateResult = await Room.updateOne(
        { roomCode: roomCode.trim() },
        {
          $set: {
            recordingLock: {
              userId: userId.trim(),
              userName: (userName ?? '').trim(),
              lockedAt: new Date(),
              expiresAt: lockExpiresAt,
            },
          },
        }
      );
      console.log('💾 Lock write result:', JSON.stringify(updateResult));

      if (updateResult.matchedCount === 0) {
        console.error('❌ No document matched for roomCode:', roomCode);
        return { success: false, message: 'Failed to update recording lock — room not matched' };
      }

      console.log('✅ Lock acquired for:', userId);
      return { success: true, message: 'Recording lock acquired' };
    } catch (error) {
      console.error('❌ acquireRecordingLock error:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Something went wrong',
      };
    }
  }

  async releaseRecordingLock(
    roomCode: string,
    userId: string
  ): Promise<{ success: boolean; message: string }> {
    console.log('🔓 releaseRecordingLock:', { roomCode, userId });

    if (!roomCode || typeof roomCode !== 'string' || roomCode.trim() === '') {
      return { success: false, message: 'Invalid room code' };
    }
    if (!userId || typeof userId !== 'string' || userId.trim() === '') {
      console.error('❌ Invalid userId:', userId);
      return { success: false, message: 'Invalid user' };
    }

    try {
      const room = await Room.findOne({ roomCode: roomCode.trim() });
      if (!room) {
        console.error('❌ Room not found for roomCode:', roomCode);
        return { success: false, message: 'Room not found' };
      }

      // Unwrap Mongoose subdoc
      const rawLock = room.toObject().recordingLock ?? null;
      console.log('🔐 Lock to release:', JSON.stringify(rawLock));

      // No lock at all — idempotent success
      if (!rawLock || !rawLock.userId) {
        console.log('✅ No lock present — nothing to release');
        return { success: true, message: 'No active recording lock' };
      }

      const lockOwnerId = rawLock.userId as string;

      // Expired lock — clear regardless of owner
      if (!this.isActiveLock(rawLock)) {
        await Room.updateOne({ roomCode: roomCode.trim() }, { $set: { recordingLock: null } });
        console.log('🧹 Cleared expired lock');
        return { success: true, message: 'Expired lock cleared' };
      }

      // Active lock owned by someone else
      if (lockOwnerId !== userId) {
        console.error(`❌ Lock owned by ${lockOwnerId}, release attempted by ${userId}`);
        return {
          success: false,
          message: 'Only the user who started recording can stop it',
        };
      }

      // Clear it
      await Room.updateOne({ roomCode: roomCode.trim() }, { $set: { recordingLock: null } });
      console.log('✅ Lock released for:', userId);
      return { success: true, message: 'Recording lock released' };
    } catch (error) {
      console.error('❌ releaseRecordingLock error:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : 'Failed to release lock',
      };
    }
  }

  async getRecordingLockStatus(roomCode: string): Promise<{
    isLocked: boolean;
    currentRecorder?: { userId: string; userName?: string; lockedSince: Date };
  }> {
    if (!roomCode || typeof roomCode !== 'string' || roomCode.trim() === '') {
      return { isLocked: false };
    }

    const room = await Room.findOne({ roomCode: roomCode.trim() });
    if (!room) throw new NotFoundError('Room not found');

    const rawLock = room.toObject().recordingLock ?? null;

    if (!this.isActiveLock(rawLock)) {
      // Silently clean up stale/expired lock
      if (rawLock && rawLock.userId) {
        await Room.updateOne({ roomCode: roomCode.trim() }, { $set: { recordingLock: null } });
      }
      return { isLocked: false };
    }

    return {
      isLocked: true,
      currentRecorder: {
        userId: rawLock.userId,
        userName: rawLock.userName,
        lockedSince: rawLock.lockedAt ?? new Date(),
      },
    };
  }

  // ─── Co-hosts ─────────────────────────────────────────────────────────────

  async generateCohostInvite(roomCode: string, userId: string): Promise<string> {
    const room = await Room.findOne({ roomCode });
    if (!room) throw new NotFoundError('Room is not found');
    if (room.teacherId.toString() !== userId)
      throw new HttpError(403, 'Only host can generate invite');

    const inviteId = uuidv4();
    const token = jwt.sign(
      { roomId: room.roomCode, jti: inviteId },
      process.env.COHOST_INVITE_SECRET!,
      { expiresIn: '30m' }
    );

    room.coHostInvite = {
      createdAt: new Date(),
      inviteId,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      isActive: true,
    };
    await room.save();
    return `${process.env.APP_ORIGINS}/teacher/cohost-invite/${token}`;
  }

  async joinAsCohost(
    token: string,
    userId: string
  ): Promise<{ message: string; roomId: string }> {
    const decoded = jwt.verify(
      token,
      process.env.COHOST_INVITE_SECRET!
    ) as CohostJwtPayload;
    const room = await Room.findOne({ roomCode: decoded.roomId });
    if (!room || room.status !== 'active') throw new HttpError(400, 'Invalid room');

    if (
      !room.coHostInvite?.isActive ||
      room.coHostInvite.inviteId !== decoded.jti ||
      room.coHostInvite.expiresAt < new Date()
    ) {
      throw new HttpError(400, 'Invite invalid or expired');
    }
    if (room.teacherId === userId) throw new HttpError(400, 'Host cannot join as cohost');

    const user = await UserModel.findOne({ firebaseUID: userId });
    if (user?.role !== 'teacher') throw new HttpError(403, 'Only teachers allowed');

    const already = room.coHosts.find(
      c => c.userId?.toString() === userId && c.isActive
    );
    if (!already) {
      room.coHosts.push({
        userId,
        addedBy: room.teacherId,
        isActive: true,
        addedAt: new Date(),
        isMicMuted: false,
      } as any);
    }
    await room.save();

    const activeCohosts = await this.getRoomCohosts(room.teacherId, decoded.roomId);
    pollSocket?.emitToRoom(decoded.roomId, 'cohost-joined', { activeCohosts });
    return { message: 'Joined as cohost', roomId: room.roomCode };
  }

  async getCohostedRooms(userId: string): Promise<GetCohostRoom> {
    const rooms = await Room.aggregate([
      { $match: { coHosts: { $elemMatch: { userId, isActive: true } } } },
      {
        $lookup: {
          from: 'users',
          let: { teacherId: '$teacherId' },
          pipeline: [
            { $match: { $expr: { $eq: ['$firebaseUID', '$$teacherId'] } } },
            { $project: { _id: 0, firstName: 1, lastName: 1 } },
          ],
          as: 'teacher',
        },
      },
      { $unwind: { path: '$teacher', preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          totalStudents: {
            $size: { $setUnion: [{ $ifNull: ['$students', []] }, []] },
          },
        },
      },
      { $sort: { createdAt: -1 } },
    ]);
    return { count: rooms.length, rooms };
  }

  async getRoomCohosts(host: string, roomCode: string): Promise<ActiveCohost[]> {
    const coHosts = await Room.aggregate<ActiveCohost>([
      { $match: { roomCode, teacherId: host } },
      { $unwind: '$coHosts' },
      { $match: { 'coHosts.isActive': true } },
      {
        $lookup: {
          from: 'users',
          let: { uid: '$coHosts.userId' },
          pipeline: [
            { $match: { $expr: { $eq: ['$firebaseUID', '$$uid'] } } },
            {
              $project: {
                _id: 0,
                firebaseUID: 1,
                firstName: 1,
                lastName: 1,
                email: 1,
              },
            },
          ],
          as: 'cohostUser',
        },
      },
      { $unwind: '$cohostUser' },
      {
        $project: {
          _id: 0,
          userId: '$cohostUser.firebaseUID',
          firstName: '$cohostUser.firstName',
          lastName: '$cohostUser.lastName',
          email: '$cohostUser.email',
          addedAt: '$coHosts.addedAt',
          isMicMuted: '$coHosts.isMicMuted',
        },
      },
    ]);
    return coHosts;
  }

  async removeCohost(
    roomCode: string,
    userId: string,
    teacherId: string
  ): Promise<{ message: string }> {
    const room = await Room.findOne({ roomCode });
    if (!room) throw new NotFoundError('Room is not found');
    if (room.teacherId !== teacherId) throw new HttpError(400, 'Invalid room');

    room.coHosts.forEach(c => {
      if (c.userId === userId) c.isActive = false;
    });
    await room.save();

    const activeCohosts = await this.getRoomCohosts(teacherId, roomCode);
    pollSocket?.emitToRoom(roomCode, 'cohost-removed', {
      removedUserId: userId,
      activeCohosts,
    });
    return { message: 'coHost removed successfully' };
  }

  async setCohostMicMuted(
    roomCode: string,
    teacherId: string,
    userId: string,
    isMicMuted: boolean
  ): Promise<{ message: string; isMicMuted: boolean }> {
    const room = await Room.findOne({ roomCode });
    if (!room) throw new NotFoundError('Room is not found');
    if (room.teacherId !== teacherId)
      throw new HttpError(403, 'Only host can manage co-host microphone');

    const cohost = room.coHosts.find(c => c.userId === userId && c.isActive);
    if (!cohost) throw new NotFoundError('Active co-host not found');

    cohost.isMicMuted = isMicMuted;

    let lockReleased = false;
    const rawLock = room.toObject().recordingLock ?? null;
    if (isMicMuted && rawLock?.userId === userId) {
      room.recordingLock = null as any;
      lockReleased = true;
    }
    await room.save();

    if (lockReleased) {
      pollSocket?.emitToRoom(roomCode, 'recording-stopped', { userId });
    }

    const activeCohosts = await this.getRoomCohosts(teacherId, roomCode);
    pollSocket?.emitToRoom(roomCode, 'cohost-mic-updated', {
      cohostId: userId,
      isMicMuted,
      activeCohosts,
    });

    return {
      message: isMicMuted ? 'Co-host microphone muted' : 'Co-host microphone unmuted',
      isMicMuted,
    };
  }

  // ─── Room Controls ────────────────────────────────────────────────────────

  async updateRoomControls(
    roomCode: string,
    userId: string,
    controlsUpdate: {
      micBlocked?: boolean;
      pollRestricted?: boolean;
      autoGenerationPaused?: boolean;
    }
  ): Promise<{ message: string; controls: any }> {
    const room = await Room.findOne({ roomCode });
    if (!room) throw new NotFoundError('Room is not found');
    if (room.teacherId !== userId)
      throw new HttpError(403, 'Only the host can update room controls');

    if (!room.controls) {
      room.controls = {
        micBlocked: false,
        pollRestricted: false,
        autoGenerationPaused: false,
      } as any;
    }

    if (controlsUpdate.micBlocked !== undefined)
      room.controls.micBlocked = controlsUpdate.micBlocked;
    if (controlsUpdate.pollRestricted !== undefined)
      room.controls.pollRestricted = controlsUpdate.pollRestricted;
    if (controlsUpdate.autoGenerationPaused !== undefined)
      room.controls.autoGenerationPaused = controlsUpdate.autoGenerationPaused;

    await room.save();

    pollSocket?.emitToRoom(roomCode, 'roomControlsUpdated', {
      micBlocked: room.controls.micBlocked,
      pollRestricted: room.controls.pollRestricted,
      autoGenerationPaused: room.controls.autoGenerationPaused,
    });

    return { message: 'Room controls updated successfully', controls: room.controls };
  }
}