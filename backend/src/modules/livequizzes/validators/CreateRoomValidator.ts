import { IsNotEmpty, IsString } from "class-validator";

export class CreateRoomValidator {
  @IsString()
  @IsNotEmpty({ message: "Room name is required" })
  name: string;

  @IsString()
  @IsNotEmpty({ message: "Teacher ID is required" })
  teacherId: string;
}
