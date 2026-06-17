import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { Types } from 'mongoose';

export class CreatePlaceRatingDto {
  // Set from the route param by the controller.
  @IsOptional()
  placeId?: Types.ObjectId;

  // Set from the authenticated JWT by the controller — never trusted from body.
  @IsOptional()
  userId?: Types.ObjectId;

  @IsOptional()
  @IsString()
  comment?: string | null;

  @Transform(({ value }) => parseInt(value as string, 10))
  @IsInt()
  @Min(1)
  @Max(5)
  score: number;
}
