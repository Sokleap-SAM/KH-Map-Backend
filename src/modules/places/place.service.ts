import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Place, PlaceDocument, PlaceStatus } from './entities/place.schema';
import { CreatePlaceDto } from './dto/create-place.dto';
import { UpdatePlaceDto } from './dto/update-place.dto';
import { deleteCloudinaryImage } from '../../config/file-upload.config';

interface CloudinaryFile extends Express.Multer.File {
  path: string;
}

@Injectable()
export class PlaceService {
  constructor(
    @InjectModel(Place.name)
    private readonly placeModel: Model<PlaceDocument>,
  ) {}

  /**
   * Admin / internal create — the place goes live immediately (APPROVED).
   * `createdBy` is the admin who created it, when available.
   */
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
        $or: [
          { status: PlaceStatus.APPROVED },
          { status: { $exists: false } },
        ],
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
  ): Promise<{ _id: Types.ObjectId; name: string }[]> {
    return this.placeModel
      .find({ category: categoryId })
      .select('_id name')
      .lean()
      .exec() as Promise<{ _id: Types.ObjectId; name: string }[]>;
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
    const updateData: Record<string, unknown> = { ...dto };

    if (dto.location) {
      updateData.location = { type: 'Point', coordinates: dto.location };
    }

    if (files && files.length > 0) {
      const existing = await this.placeModel.findById(id).exec();
      if (!existing)
        throw new NotFoundException(`Place ${id.toString()} not found`);

      // Delete old photos from Cloudinary
      await Promise.all(
        existing.photos.map((url) => deleteCloudinaryImage(url)),
      );

      updateData.photos = files.map((file) => (file as CloudinaryFile).path);
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
