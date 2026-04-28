import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { Types } from 'mongoose';
import { PlaceService } from './place.service';
import { PlaceCategoryService } from './place-category.service';
import { PlaceRatingService } from './place-rating.service';
import { CreatePlaceDto } from './dto/create-place.dto';
import { UpdatePlaceDto } from './dto/update-place.dto';
import { CreatePlaceCategoryDto } from './dto/create-place-category.dto';
import { UpdatePlaceCategoryDto } from './dto/update-place-category.dto';
import { CreatePlaceRatingDto } from './dto/create-place-rating.dto';
import { UpdatePlaceRatingDto } from './dto/update-place-rating.dto';
import {
  FilesInterceptor,
  AnyFilesInterceptor,
} from '@nestjs/platform-express';
import { createCloudinaryStorage } from '../../config/file-upload.config';

const placeStorage = createCloudinaryStorage('places');

@Controller('places')
export class PlaceController {
  constructor(
    private readonly placeService: PlaceService,
    private readonly categoryService: PlaceCategoryService,
    private readonly ratingService: PlaceRatingService,
  ) {}

  @Post('categories')
  @UseInterceptors(AnyFilesInterceptor())
  createCategory(@Body() dto: CreatePlaceCategoryDto) {
    return this.categoryService.create(dto);
  }

  @Get('categories')
  findAllCategories() {
    return this.categoryService.findAll();
  }

  @Get('categories/:categoryId')
  findOneCategory(@Param('categoryId') categoryId: string) {
    return this.categoryService.findOne(new Types.ObjectId(categoryId));
  }

  @Patch('categories/:categoryId')
  @UseInterceptors(AnyFilesInterceptor())
  updateCategory(
    @Param('categoryId') categoryId: string,
    @Body() dto: UpdatePlaceCategoryDto,
  ) {
    return this.categoryService.update(new Types.ObjectId(categoryId), dto);
  }

  @Delete('categories/:categoryId')
  removeCategory(@Param('categoryId') categoryId: string) {
    return this.categoryService.remove(new Types.ObjectId(categoryId));
  }

  @Post()
  @UseInterceptors(FilesInterceptor('photos', 10, { storage: placeStorage }))
  create(
    @Body() dto: CreatePlaceDto,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    return this.placeService.create(dto, files);
  }

  @Get()
  findAll() {
    return this.placeService.findAll();
  }

  @Get('category/:categoryId')
  findByCategory(@Param('categoryId') categoryId: string) {
    return this.placeService.findByCategory(new Types.ObjectId(categoryId));
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.placeService.findOne(new Types.ObjectId(id));
  }

  @Patch(':id')
  @UseInterceptors(FilesInterceptor('photos', 10, { storage: placeStorage }))
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePlaceDto,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    return this.placeService.update(new Types.ObjectId(id), dto, files);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.placeService.remove(new Types.ObjectId(id));
  }

  @Post(':placeId/ratings')
  @UseInterceptors(AnyFilesInterceptor())
  createRating(
    @Param('placeId') placeId: string,
    @Body() dto: CreatePlaceRatingDto,
  ) {
    dto.placeId = new Types.ObjectId(placeId);
    return this.ratingService.create(dto);
  }

  @Get(':placeId/ratings')
  findAllRatings(@Param('placeId') placeId: string) {
    return this.ratingService.findAllByPlace(new Types.ObjectId(placeId));
  }

  @Get(':placeId/ratings/:ratingId')
  findOneRating(@Param('ratingId') ratingId: string) {
    return this.ratingService.findOne(new Types.ObjectId(ratingId));
  }

  @Patch(':placeId/ratings/:ratingId')
  @UseInterceptors(AnyFilesInterceptor())
  updateRating(
    @Param('ratingId') ratingId: string,
    @Body() dto: UpdatePlaceRatingDto,
  ) {
    return this.ratingService.update(new Types.ObjectId(ratingId), dto);
  }

  @Delete(':placeId/ratings/:ratingId')
  removeRating(@Param('ratingId') ratingId: string) {
    return this.ratingService.remove(new Types.ObjectId(ratingId));
  }
}
