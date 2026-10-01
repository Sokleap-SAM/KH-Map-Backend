import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  SearchHistory,
  SearchHistoryDocument,
} from './entities/search-history.schema';
import { AddSearchHistoryDto } from './dto/add-search-history.dto';

const MAX_ENTRIES = 30;

@Injectable()
export class SearchHistoryService {
  constructor(
    @InjectModel(SearchHistory.name)
    private readonly searchHistoryModel: Model<SearchHistoryDocument>,
  ) {}

  async findByUser(userId: string): Promise<SearchHistory[]> {
    return this.searchHistoryModel
      .find({ userId: new Types.ObjectId(userId) })
      .sort({ searchedAt: -1 })
      .limit(MAX_ENTRIES)
      .lean()
      .exec();
  }

  async add(
    userId: string,
    dto: AddSearchHistoryDto,
  ): Promise<SearchHistory[]> {
    const userObjectId = new Types.ObjectId(userId);

    await this.searchHistoryModel
      .findOneAndUpdate(
        { userId: userObjectId, placeId: dto.placeId },
        {
          $set: {
            name: dto.name,
            categoryName: dto.categoryName ?? 'Place',
            latitude: dto.latitude,
            longitude: dto.longitude,
            searchedAt: new Date(),
          },
          $setOnInsert: { userId: userObjectId, placeId: dto.placeId },
        },
        { upsert: true, new: true },
      )
      .exec();

    const count = await this.searchHistoryModel
      .countDocuments({ userId: userObjectId })
      .exec();

    if (count > MAX_ENTRIES) {
      const excess = await this.searchHistoryModel
        .find({ userId: userObjectId })
        .sort({ searchedAt: -1 })
        .skip(MAX_ENTRIES)
        .select('_id')
        .lean()
        .exec();

      if (excess.length > 0) {
        await this.searchHistoryModel
          .deleteMany({ _id: { $in: excess.map((e) => e._id) } })
          .exec();
      }
    }

    return this.findByUser(userId);
  }

  async remove(userId: string, placeId: string): Promise<SearchHistory[]> {
    await this.searchHistoryModel
      .deleteOne({ userId: new Types.ObjectId(userId), placeId })
      .exec();
    return this.findByUser(userId);
  }

  async clear(userId: string): Promise<{ deletedCount: number }> {
    const result = await this.searchHistoryModel
      .deleteMany({ userId: new Types.ObjectId(userId) })
      .exec();
    return { deletedCount: result.deletedCount ?? 0 };
  }
}
