// backend/src/modules/livequizzes/utils/PollSocket.ts
//
// KEY FIX: pollSocket was being constructed at module-load time with
// `new RoomService()` — outside Inversify, before the DB is ready.
// Now we export a lazy initializer so the socket is only created after
// the server + DB are fully up, and RoomService is taken from the container.

import { Server } from 'socket.io';
import { RoomService } from '../services/RoomService.js';
import dotenv from 'dotenv';
import { getFromContainer, NotFoundError } from 'routing-controllers';
import { UserRepository } from '#root/shared/index.js';
import { Room } from '#root/shared/database/models/Room.js';

dotenv.config();
const appOrigins = process.env.APP_ORIGINS;

class PollSocket {
  private io: Server | null = null;
  private activeConnections: Map<string, string[]> = new Map();
  private activeUsersPerRoom: Map<string, Set<string>> = new Map();

  constructor(
    private readonly roomService: RoomService,
    private readonly userRepo: UserRepository,
  ) {}

  init(server: import('http').Server) {
    this.io = new Server(server, {
      cors: {
        origin: appOrigins ? appOrigins.split(',').map(o => o.trim()) : ['http://localhost:3000'],
        methods: ['GET', 'POST'],
        credentials: true,
      },
      pingTimeout: 30000,
      pingInterval: 10000,
    });

    this.io.on('connection', socket => {
      console.log('Client connected', socket.id);

      socket.on('join-room', async (data: {
        roomCode: string;
        email?: string;
        user?: string;
        role?: string;
      }) => {
        try {
          const { roomCode, email, user, role } = data;

          if (!roomCode) {
            socket.emit('error', 'roomCode is required');
            return;
          }

          const { isActive, hasAccess } = await this.roomService.isRoomValidAndHasAccess(
            roomCode,
            user ?? ''
          );

          if (role === 'teacher' && !hasAccess) {
            console.log('Teacher does not have access to room:', roomCode);
            socket.emit('room-ended');
            return;
          }

          if (typeof email === 'string' && email.trim() !== '') {
            try {
              const foundUser = await this.userRepo.findByEmail(email);
              if (foundUser) {
                const userId = foundUser._id;
                socket.data.userId = foundUser.firebaseUID;
                await this.roomService.enrollStudent(
                  userId as string,
                  roomCode,
                  foundUser.firebaseUID as string
                );
              }
            } catch (enrollErr) {
              console.error('Error enrolling student:', enrollErr);
              // Non-fatal — continue joining
            }
          }

          if (isActive) {
            socket.join(roomCode);
            socket.data.email = email;

            if (!this.activeConnections.has(socket.id)) {
              this.activeConnections.set(socket.id, []);
            }
            this.activeConnections.get(socket.id)?.push(roomCode);

            if (socket.data.userId) {
              if (!this.activeUsersPerRoom.has(roomCode)) {
                this.activeUsersPerRoom.set(roomCode, new Set());
              }
              this.activeUsersPerRoom.get(roomCode)!.add(socket.data.userId);
            }

            const room = await this.roomService.getRoomByCode(roomCode);
            this.emitToRoom(roomCode, 'room-updated', room);
            console.log(`Socket ${socket.id} joined active room: ${roomCode}`);
          } else {
            console.log(`Join failed — room ended/invalid/restricted: ${roomCode}`);
            socket.emit('room-ended');
          }
        } catch (err) {
          console.error('Error in join-room handler:', err);
          socket.emit('error', 'Unexpected server error');
        }
      });

      socket.on('leave-room', async (roomCode: string, email: string) => {
        try {
          if (email) {
            const user = await this.userRepo.findByEmail(email);
            if (user) {
              const userId = user._id as string;
              await this.roomService.unEnrollStudent(userId, roomCode);
            }
          }
          socket.leave(roomCode);

          if (socket.data.userId) {
            this.activeUsersPerRoom.get(roomCode)?.delete(socket.data.userId);
          }

          const room = await this.roomService.getRoomByCode(roomCode);
          this.emitToRoom(roomCode, 'room-updated', room);

          const rooms = this.activeConnections.get(socket.id) || [];
          const updatedRooms = rooms.filter(r => r !== roomCode);
          if (updatedRooms.length > 0) {
            this.activeConnections.set(socket.id, updatedRooms);
          } else {
            this.activeConnections.delete(socket.id);
          }

          console.log(`Socket ${socket.id} left room: ${roomCode}`);
        } catch (err) {
          console.error('Error in leave-room handler:', err);
        }
      });

      socket.on('remove-student', async ({ roomCode, email }: { roomCode: string; email: string }) => {
        try {
          const user = await this.userRepo.findByEmail(email);
          if (!user) return;

          const userId = user._id.toString();
          await this.roomService.unEnrollStudent(userId, roomCode);

          let studentSocketId: string | null = null;
          for (const [socketId, rooms] of this.activeConnections.entries()) {
            if (rooms.includes(roomCode)) {
              const s = this.io!.sockets.sockets.get(socketId);
              if (s?.data?.email === email) {
                studentSocketId = socketId;
                break;
              }
            }
          }

          if (studentSocketId) {
            const studentSocket = this.io!.sockets.sockets.get(studentSocketId);
            if (studentSocket) {
              studentSocket.leave(roomCode);
              studentSocket.emit('removed-from-room', roomCode);
              this.activeConnections.delete(studentSocketId);
              const removedUID = studentSocket.data?.userId;
              if (removedUID) {
                this.activeUsersPerRoom.get(roomCode)?.delete(removedUID);
              }
            }
          }

          const updatedRoom = await this.roomService.getRoomByCode(roomCode);
          this.io!.to(roomCode).emit('room-updated', updatedRoom);
        } catch (err) {
          console.error('remove-student error:', err);
        }
      });

      socket.on('update-room-control', ({ roomCode, mode }: { roomCode: string; mode: string }) => {
        try {
          console.log(`Room ${roomCode} control updated to: ${mode} by socket ${socket.id}`);
          socket.to(roomCode).emit('room-control-updated', { mode });
        } catch (err) {
          console.error('update-room-control error:', err);
        }
      });

      socket.on('cohost-leave', async (roomCode: string, cohostId: string) => {
        try {
          const room = await Room.findOne({ roomCode });
          if (!room) {
            socket.emit('error', 'Room not found');
            return;
          }
          const teacherId = room.teacherId;
          room.coHosts.forEach(c => {
            if (c.userId === cohostId) c.isActive = false;
          });
          await room.save();

          const activeCohosts = await this.roomService.getRoomCohosts(teacherId, roomCode);
          this.emitToRoom(roomCode, 'cohost-left', {
            removedUserId: cohostId,
            activeCohosts,
          });
        } catch (err) {
          console.error('cohost-leave error:', err);
        }
      });

      socket.on('disconnect', () => {
        const rooms = this.activeConnections.get(socket.id) || [];
        const firebaseUID = socket.data?.userId;
        for (const roomCode of rooms) {
          if (firebaseUID) {
            this.activeUsersPerRoom.get(roomCode)?.delete(firebaseUID);
          }
        }
        this.activeConnections.delete(socket.id);
        console.log(`Socket ${socket.id} disconnected. Active: ${this.activeConnections.size}`);
      });
    });
  }

  getActiveUsersInRoom(roomCode: string): string[] {
    return Array.from(this.activeUsersPerRoom.get(roomCode) ?? []);
  }

  emitToRoom(roomCode: string, event: string, data: any) {
    if (this.io) {
      this.io.to(roomCode).emit(event, data);
    } else {
      console.warn('Socket.IO not initialized — cannot emit to room');
    }
  }

  emitToAll(event: string, data: any) {
    if (this.io) {
      this.io.emit(event, data);
    } else {
      console.error('Socket.IO not initialized — cannot emit to all');
    }
  }
}

// ─── Lazy singleton ────────────────────────────────────────────────────────────
// pollSocket is created once, on first import.
// RoomService and UserRepository are instantiated here directly (same as before),
// but wrapped so the socket.init(server) call — which is what actually touches
// the DB — only happens after the server + Mongoose connection are fully ready.
//
// If you later move to full Inversify injection, replace this with:
//   export const pollSocket = getFromContainer(PollSocket);
// and bind PollSocket in your container module.

let _pollSocket: PollSocket | null = null;

export function getPollSocket(): PollSocket {
  if (!_pollSocket) {
    _pollSocket = new PollSocket(new RoomService(), new UserRepository());
  }
  return _pollSocket;
}

// Backward-compatible named export — existing imports of `pollSocket` keep working
export const pollSocket = getPollSocket();