import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  PlaceCategory,
  PlaceCategoryDocument,
} from './entities/place-category.schema';
import { Place, PlaceDocument, PlaceStatus } from './entities/place.schema';
import { CreatePlaceDto } from './dto/create-place.dto';
import { UpdatePlaceDto } from './dto/update-place.dto';
import { deleteCloudinaryImage } from '../../config/file-upload.config';

interface CloudinaryFile extends Express.Multer.File {
  path: string;
}

// Canonical category name used to mark a Place as a bus stop. Matched
// case-sensitively against PlaceCategory.name; auto-created on first use so
// no seeder is required.
const STOP_CATEGORY_NAME = 'test_bus_stop';

@Injectable()
export class PlaceService {
  // Cached so we don't re-query PlaceCategory on every stop request.
  private stopCategoryIdCache: Types.ObjectId | null = null;

  constructor(
    @InjectModel(Place.name)
    private readonly placeModel: Model<PlaceDocument>,
    @InjectModel(PlaceCategory.name)
    private readonly placeCategoryModel: Model<PlaceCategoryDocument>,
  ) {}

  /**
   * Resolve the "Bus Stop" category ObjectId, creating the category row on
   * first call. Callers should use this rather than holding the name as a
   * magic string — the lookup is cached after the first hit.
   */
  private async getStopCategoryId(): Promise<Types.ObjectId> {
    if (this.stopCategoryIdCache) return this.stopCategoryIdCache;
    let cat = await this.placeCategoryModel
      .findOne({ name: STOP_CATEGORY_NAME })
      .exec();
    if (!cat) {
      cat = await this.placeCategoryModel.create({ name: STOP_CATEGORY_NAME });
    }
    this.stopCategoryIdCache = cat._id;
    return cat._id;
  }

  // ─── Bus-stop convenience methods ──────────────────────────────────────────

  async findAllStops(): Promise<Place[]> {
    const stopCatId = await this.getStopCategoryId();
    return this.placeModel
      .find({ category: stopCatId })
      .populate('category')
      .exec();
  }

  async createStop(
    dto: CreatePlaceDto,
    files?: Express.Multer.File[],
  ): Promise<Place> {
    const stopCatId = await this.getStopCategoryId();
    const photos = files?.map((file) => (file as CloudinaryFile).path) ?? [];
    const location = { type: 'Point' as const, coordinates: dto.location };
    // Override whatever category the caller sent — stops always belong to the
    // canonical "Bus Stop" category.
    return this.placeModel.create({
      ...dto,
      category: stopCatId,
      location,
      photos,
    });
  }

  async countStops(): Promise<number> {
    const stopCatId = await this.getStopCategoryId();
    return this.placeModel.countDocuments({ category: stopCatId }).exec();
  }

  async create(
    dto: CreatePlaceDto,
    files?: Express.Multer.File[],
    createdBy?: Types.ObjectId | null,
  ): Promise<Place> {
    const photos = files?.map((file) => (file as CloudinaryFile).path) ?? [];
    const location = { type: 'Point' as const, coordinates: dto.location };
    return this.placeModel.create({
      ...dto,
      location,
      photos,
      status: PlaceStatus.APPROVED,
      createdBy: createdBy ?? null,
    });
  }

  /**
   * User-submitted create — the place is held as PENDING until an admin
   * approves it, so it does NOT appear on the public map yet.
   */
  async createRequest(
    dto: CreatePlaceDto,
    createdBy: Types.ObjectId,
    files?: Express.Multer.File[],
  ): Promise<Place> {
    const photos = files?.map((file) => (file as CloudinaryFile).path) ?? [];
    const location = { type: 'Point' as const, coordinates: dto.location };
    return this.placeModel.create({
      ...dto,
      location,
      photos,
      status: PlaceStatus.PENDING,
      createdBy,
    });
  }

  /**
   * Public list (map): only approved places. Legacy documents created before
   * the approval workflow have no `status` field — treat those as approved too.
   */
  async findAll(): Promise<Place[]> {
    return this.placeModel
      .find({
        $or: [{ status: PlaceStatus.APPROVED }, { status: { $exists: false } }],
      })
      .populate('category')
      .exec();
  }

  /** Admin: every place still awaiting review, newest first. */
  async findPending(): Promise<Place[]> {
    return this.placeModel
      .find({ status: PlaceStatus.PENDING })
      .populate('category')
      .sort({ createdAt: -1 })
      .exec();
  }

  /** The requests a given user submitted (all statuses), newest first. */
  async findByCreator(createdBy: Types.ObjectId): Promise<Place[]> {
    return this.placeModel
      .find({ createdBy })
      .populate('category')
      .sort({ createdAt: -1 })
      .exec();
  }

  /**
   * Admin: the review log — every request that has been approved or rejected,
   * most-recently-reviewed first. Admin-created stops and legacy docs never go
   * through review (no `reviewedAt`) so they are excluded; rejected places are
   * always request-originated, so they are kept even if they were reviewed
   * before review-tracking existed.
   */
  async findReviewHistory(): Promise<Place[]> {
    return this.placeModel
      .find({
        status: { $in: [PlaceStatus.APPROVED, PlaceStatus.REJECTED] },
        $or: [{ reviewedAt: { $ne: null } }, { status: PlaceStatus.REJECTED }],
      })
      .populate('category')
      .populate('reviewedBy', 'name')
      .populate('createdBy', 'name')
      .sort({ reviewedAt: -1, updatedAt: -1 })
      .exec();
  }

  /**
   * Admin: approve / reject a pending request, recording who reviewed and when.
   * On reject, `rejectionReason` is stored so the submitter can see why; on
   * approve it is cleared so a re-approved place carries no stale reason.
   */
  async setStatus(
    id: Types.ObjectId,
    status: PlaceStatus,
    reviewedBy?: Types.ObjectId | null,
    rejectionReason?: string | null,
  ): Promise<Place> {
    const place = await this.placeModel
      .findByIdAndUpdate(
        id,
        {
          status,
          reviewedBy: reviewedBy ?? null,
          reviewedAt: new Date(),
          rejectionReason:
            status === PlaceStatus.REJECTED ? (rejectionReason ?? null) : null,
        },
        { new: true },
      )
      .populate('category')
      .exec();
    if (!place) throw new NotFoundException(`Place ${id.toString()} not found`);
    return place;
  }

  async findByCategory(
    categoryId: Types.ObjectId,
  ): Promise<{ _id: Types.ObjectId; nameInKhmer: string }[]> {
    return this.placeModel
      .find({ category: categoryId })
      .select('_id nameInKhmer')
      .lean()
      .exec() as Promise<{ _id: Types.ObjectId; nameInKhmer: string }[]>;
  }

  async findOne(id: Types.ObjectId): Promise<Place> {
    const place = await this.placeModel
      .findById(id)
      .populate('category')
      .exec();
    if (!place) throw new NotFoundException(`Place ${id.toString()} not found`);
    return place;
  }

  async update(
    id: Types.ObjectId,
    dto: UpdatePlaceDto,
    files?: Express.Multer.File[],
  ): Promise<Place> {
    const { photos: keep, location, ...rest } = dto;
    const updateData: Record<string, unknown> = { ...rest };

    if (location) {
      updateData.location = { type: 'Point', coordinates: location };
    }

    const uploaded = (files ?? []).map((f) => (f as CloudinaryFile).path);

    // Only recompute photos when the client managed them (sent a keep-list
    // and/or new files). Otherwise leave the existing photos untouched.
    if (keep !== undefined || uploaded.length > 0) {
      const existing = await this.placeModel.findById(id).exec();
      if (!existing)
        throw new NotFoundException(`Place ${id.toString()} not found`);

      // If no keep-list was sent (upload-only client), keep the current photos.
      const keepList = keep ?? existing.photos;

      // Delete from Cloudinary only the photos that are no longer kept.
      const removed = existing.photos.filter((url) => !keepList.includes(url));
      await Promise.all(removed.map((url) => deleteCloudinaryImage(url)));

      updateData.photos = [...keepList, ...uploaded];
    }

    const place = await this.placeModel
      .findByIdAndUpdate(id, updateData, { new: true })
      .populate('category')
      .exec();
    if (!place) throw new NotFoundException(`Place ${id.toString()} not found`);
    return place;
  }

  async remove(id: Types.ObjectId): Promise<void> {
    const place = await this.placeModel.findById(id).exec();
    if (!place) throw new NotFoundException(`Place ${id.toString()} not found`);

    // Delete photos from Cloudinary
    await Promise.all(place.photos.map((url) => deleteCloudinaryImage(url)));

    await this.placeModel.findByIdAndDelete(id).exec();
  }
}
