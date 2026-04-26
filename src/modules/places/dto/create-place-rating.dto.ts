import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { Types } from 'mongoose';

export class CreatePlaceRatingDto {
  @IsOptional()
  placeId: Types.ObjectId;

  @IsNotEmpty()
  @Transform(({ value }) =>
    value ? new Types.ObjectId(value as string) : null,
  )
  userId: Types.ObjectId;

  @IsOptional()
  @IsString()
  comment?: string | null;

  @Transform(({ value }) => parseInt(value as string, 10))
  @IsInt()
  @Min(1)
  @Max(5)
  score: number;
}
