import { PartialType } from '@nestjs/mapped-types';
import { CreatePlaceRatingDto } from './create-place-rating.dto';

export class UpdatePlaceRatingDto extends PartialType(CreatePlaceRatingDto) {}
