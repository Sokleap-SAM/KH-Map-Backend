import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  PlaceRating,
  PlaceRatingDocument,
} from './entities/place-rating.schema';
import { Place, PlaceDocument } from './entities/place.schema';
import { CreatePlaceRatingDto } from './dto/create-place-rating.dto';
import { UpdatePlaceRatingDto } from './dto/update-place-rating.dto';

interface CloudinaryFile extends Express.Multer.File {
  path: string;
}

@Injectable()
export class PlaceRatingService {
  constructor(
    @InjectModel(PlaceRating.name)
    private readonly placeRatingModel: Model<PlaceRatingDocument>,
    @InjectModel(Place.name)
    private readonly placeModel: Model<PlaceDocument>,
  ) {}

  async create(
    dto: CreatePlaceRatingDto,
    files?: Express.Multer.File[],
  ): Promise<PlaceRating> {
    const photos = files?.map((file) => (file as CloudinaryFile).path) ?? [];
    const placeId = dto.placeId!.toString();
    const userId = dto.userId!.toString();

    // One rating per user per place — re-submitting updates the existing one.
    const rating = await this.placeRatingModel
      .findOneAndUpdate(
        { placeId, userId },
        { $set: { score: dto.score, comment: dto.comment ?? null, photos } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .exec();

    await this.recomputePlaceAggregate(placeId);
    return rating!;
  }

  async findAllByPlace(placeId: Types.ObjectId): Promise<PlaceRating[]> {
    return this.placeRatingModel.find({ placeId: placeId.toString() }).exec();
  }

  async findOne(id: Types.ObjectId): Promise<PlaceRating> {
    const rating = await this.placeRatingModel.findById(id).exec();
    if (!rating)
      throw new NotFoundException(`PlaceRating ${id.toString()} not found`);
    return rating;
  }

  async update(
    id: Types.ObjectId,
    dto: UpdatePlaceRatingDto,
  ): Promise<PlaceRating> {
    const rating = await this.placeRatingModel
      .findByIdAndUpdate(id, dto, { new: true })
      .exec();
    if (!rating)
      throw new NotFoundException(`PlaceRating ${id.toString()} not found`);
    await this.recomputePlaceAggregate(rating.placeId);
    return rating;
  }

  async remove(id: Types.ObjectId): Promise<void> {
    const result = await this.placeRatingModel.findByIdAndDelete(id).exec();
    if (!result)
      throw new NotFoundException(`PlaceRating ${id.toString()} not found`);
    await this.recomputePlaceAggregate(result.placeId);
  }

  async recomputeForPlace(placeId: Types.ObjectId): Promise<void> {
    await this.recomputePlaceAggregate(placeId.toString());
  }

  /**
   * Recomputes a place's denormalised rating summary (averageRating +
   * ratingCount) from its rating documents and persists it on the place.
   */
  private async recomputePlaceAggregate(placeId: string): Promise<void> {
    const [summary] = await this.placeRatingModel
      .aggregate<{ averageRating: number; ratingCount: number }>([
        { $match: { placeId } },
        {
          $group: {
            _id: '$placeId',
            averageRating: { $avg: '$score' },
            ratingCount: { $sum: 1 },
          },
        },
      ])
      .exec();

    await this.placeModel
      .findByIdAndUpdate(placeId, {
        averageRating: summary
          ? Math.round(summary.averageRating * 10) / 10
          : null,
        ratingCount: summary ? summary.ratingCount : 0,
      })
      .exec();
  }
}
