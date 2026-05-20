import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNotEmpty, IsOptional, IsString, ArrayMinSize, Max, Min } from "class-validator";

export class CreatePollValidator {
  @IsString()
  @IsNotEmpty({ message: "Question is required" })
  question: string;

  @IsArray()
  @ArrayMinSize(2, { message: "At least two options are required" })
  @IsString({ each: true })
  options: string[];

  @Type(() => Number)
  @IsInt()
  @Min(0)
  correctOptionIndex: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(300)
  timer?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxPoints?: number;

  @IsOptional()
  @IsString()
  creatorId?: string;
}
