import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';
import { Types } from 'mongoose';

export class CreateBusTripDto {
  @IsNotEmpty()
  @Transform(({ value }) => new Types.ObjectId(value as string))
  route!: Types.ObjectId;

  @IsNotEmpty()
  @Transform(({ value }) => new Types.ObjectId(value as string))
  bus!: Types.ObjectId;

  @IsOptional()
  @IsString()
  @IsIn(['scheduled', 'in-progress', 'completed', 'cancelled'])
  status?: string;
}
