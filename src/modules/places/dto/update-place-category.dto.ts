import { PartialType } from '@nestjs/mapped-types';
import { CreatePlaceCategoryDto } from './create-place-category.dto';

export class UpdatePlaceCategoryDto extends PartialType(
  CreatePlaceCategoryDto,
) {}
