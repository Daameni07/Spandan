import { JwtPayload } from "jsonwebtoken";

export interface PollAnswer {
  userId: string;
  answerIndex: number;
  answeredAt: Date;
  points?: number;
}

export interface Poll {
  _id: string; // uuid string
  question: string;
  options: string[];
  correctOptionIndex: number;
  timer: number;
  maxPoints?: number;
  lockedActiveUsers?: string[];
  createdAt: Date;
  answers: PollAnswer[];
}

export interface GeneratedQuestion {
  question: string;
  options: string[];
  correctOptionIndex: number;
}

export interface Room {
  roomCode: string;
  name: string;
  teacherId: string;
  teacherName?: string;
  createdAt: Date;
  endedAt?: Date;
  status: 'active' | 'ended';
  polls: Poll[];
  generatedQuestions?: GeneratedQuestion[];
  totalStudents?: number;
  coHosts?: ActiveCohost[];
  controls?: {
    micBlocked: boolean;
    pollRestricted: boolean;
    autoGenerationPaused?: boolean;
  };
  joinedStudents?: string[];
  students?: {firstName: string, email: string}[];
  recordingLock?: {
    userId: string;
    userName?: string;
    expiresAt?: Date;
  } | null;
}

export interface CohostJwtPayload extends JwtPayload {
  roomId: string;
  jti: string;
}

export interface GetCohostRoom {
  rooms: Room[];
  count: number;
}

export interface ActiveCohost {
  userId: string;
  isActive: boolean;
  firstName: string;
  lastName: string;
  email: string;
  addedAt: Date;
  addedBy: string;
  isMicMuted: boolean;
}

