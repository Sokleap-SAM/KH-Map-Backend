import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Request as Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request } from 'express';
import { Types } from 'mongoose';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../users/enums/role.enum';
import { PlaceService } from './place.service';
import { PlaceStatus } from './entities/place.schema';
import { PlaceCategoryService } from './place-category.service';
import { PlaceRatingService } from './place-rating.service';
import { CreatePlaceDto } from './dto/create-place.dto';
import { UpdatePlaceDto } from './dto/update-place.dto';
import { RejectPlaceDto } from './dto/reject-place.dto';
import { CreatePlaceCategoryDto } from './dto/create-place-category.dto';
import { UpdatePlaceCategoryDto } from './dto/update-place-category.dto';
import { CreatePlaceRatingDto } from './dto/create-place-rating.dto';
import { UpdatePlaceRatingDto } from './dto/update-place-rating.dto';
import {
  FilesInterceptor,
  AnyFilesInterceptor,
} from '@nestjs/platform-express';
import { createCloudinaryStorage } from '../../config/file-upload.config';

interface AuthenticatedRequest extends Request {
  user: {
    userId: string;
    email: string;
    role: string;
  };
}

const placeStorage = createCloudinaryStorage('places');
const ratingStorage = createCloudinaryStorage('ratings');

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

  // ─── Place requests (user submission → admin approval) ─────────────────────
  // Declared before the generic `:id` routes so the literal `requests` path
  // segment is matched first.

  /** Any logged-in user submits a new place — held as PENDING for review. */
  @Post('requests')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FilesInterceptor('photos', 10, { storage: placeStorage }))
  createRequest(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreatePlaceDto,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    return this.placeService.createRequest(
      dto,
      new Types.ObjectId(req.user.userId),
      files,
    );
  }

  /** Admin: list every place still awaiting review. */
  @Get('requests/pending')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  findPendingRequests() {
    return this.placeService.findPending();
  }

  /** Admin: the approve/reject review log, most-recently-reviewed first. */
  @Get('requests/history')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  findReviewHistory() {
    return this.placeService.findReviewHistory();
  }

  /** The caller's own submitted requests (all statuses), for status feedback. */
  @Get('requests/mine')
  @UseGuards(JwtAuthGuard)
  findMyRequests(@Req() req: AuthenticatedRequest) {
    return this.placeService.findByCreator(new Types.ObjectId(req.user.userId));
  }

  /** Admin: approve a pending request — the place goes live on the map. */
  @Patch('requests/:id/approve')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  approveRequest(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.placeService.setStatus(
      new Types.ObjectId(id),
      PlaceStatus.APPROVED,
      new Types.ObjectId(req.user.userId),
    );
  }

  /**
   * Admin: reject a pending request — kept hidden, flagged for the submitter
   * with a required reason so they can see why and fix/re-submit.
   */
  @Patch('requests/:id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  rejectRequest(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: RejectPlaceDto,
  ) {
    return this.placeService.setStatus(
      new Types.ObjectId(id),
      PlaceStatus.REJECTED,
      new Types.ObjectId(req.user.userId),
      dto.reason,
    );
  }

  // ─── Places ────────────────────────────────────────────────────────────────

  /** Admin-only direct create (e.g. bus stops) — published immediately. */
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @UseInterceptors(FilesInterceptor('photos', 10, { storage: placeStorage }))
  create(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreatePlaceDto,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    return this.placeService.create(
      dto,
      files,
      new Types.ObjectId(req.user.userId),
    );
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
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FilesInterceptor('photos', 10, { storage: ratingStorage }))
  createRating(
    @Req() req: AuthenticatedRequest,
    @Param('placeId') placeId: string,
    @Body() dto: CreatePlaceRatingDto,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    dto.placeId = new Types.ObjectId(placeId);
    dto.userId = new Types.ObjectId(req.user.userId);
    return this.ratingService.create(dto, files);
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

  @Post(':placeId/ratings/recompute')
  recomputeRatings(@Param('placeId') placeId: string) {
    return this.ratingService.recomputeForPlace(new Types.ObjectId(placeId));
  }
}
