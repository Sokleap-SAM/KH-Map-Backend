import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Favorite, FavoriteDocument } from './entities/favorite.schema';
import { AddFavoriteDto } from './dto/add-favorite.dto';

@Injectable()
export class FavoritesService {
  constructor(
    @InjectModel(Favorite.name)
    private readonly favoriteModel: Model<FavoriteDocument>,
  ) {}

  async findByUser(userId: string): Promise<Favorite[]> {
    return this.favoriteModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ favoritedAt: -1 })
      .lean()
      .exec();
  }

  async add(userId: string, dto: AddFavoriteDto): Promise<Favorite[]> {
    const userObjectId = new Types.ObjectId(userId);

    await this.favoriteModel
      .findOneAndUpdate(
        { userId: userObjectId, placeId: dto.placeId },
        {
          $set: {
            name: dto.name,
            categoryName: dto.categoryName ?? 'Place',
            latitude: dto.latitude,
            longitude: dto.longitude,
            photo: dto.photo ?? null,
            averageRating: dto.averageRating ?? null,
            ratingCount: dto.ratingCount ?? null,
          },
          $setOnInsert: {
            userId: userObjectId,
            placeId: dto.placeId,
            favoritedAt: new Date(),
          },
        },
        { upsert: true, new: true },
      )
      .exec();

    return this.findByUser(userId);
  }

  async remove(userId: string, placeId: string): Promise<Favorite[]> {
    await this.favoriteModel
      .deleteOne({ userId: new Types.ObjectId(userId), placeId })
      .exec();
    return this.findByUser(userId);
  }

  async clear(userId: string): Promise<{ deletedCount: number }> {
    const result = await this.favoriteModel
      .deleteMany({ userId: new Types.ObjectId(userId) })
      .exec();
    return { deletedCount: result.deletedCount ?? 0 };
  }
}
