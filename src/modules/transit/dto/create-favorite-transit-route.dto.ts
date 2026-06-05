import { Type, Transform } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Types } from 'mongoose';

class SkeletonEndpointDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @IsNumber({}, { each: true })
  coordinates!: [number, number]; // [lng, lat]
}

class SkeletonLegDto {
  @IsNotEmpty()
  @Transform(({ value }) => new Types.ObjectId(value as string))
  route!: Types.ObjectId;

  @IsNotEmpty()
  @Transform(({ value }) => new Types.ObjectId(value as string))
  boardStop!: Types.ObjectId;

  @IsNotEmpty()
  @Transform(({ value }) => new Types.ObjectId(value as string))
  alightStop!: Types.ObjectId;
}

export class CreateFavoriteTransitRouteDto {
  @IsNotEmpty()
  @Transform(({ value }) => new Types.ObjectId(value as string))
  user!: Types.ObjectId;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @ValidateNested()
  @Type(() => SkeletonEndpointDto)
  origin!: SkeletonEndpointDto;

  @ValidateNested()
  @Type(() => SkeletonEndpointDto)
  destination!: SkeletonEndpointDto;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => SkeletonLegDto)
  legs!: SkeletonLegDto[];
}
