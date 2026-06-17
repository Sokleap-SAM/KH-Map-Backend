import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  FavoriteTransitRoute,
  FavoriteTransitRouteDocument,
} from './entities/favorite-transit-route.schema';
import { CreateFavoriteTransitRouteDto } from './dto/create-favorite-transit-route.dto';

@Injectable()
export class FavoriteTransitRouteService {
  constructor(
    @InjectModel(FavoriteTransitRoute.name)
    private readonly favoriteModel: Model<FavoriteTransitRouteDocument>,
  ) {}

  async create(
    dto: CreateFavoriteTransitRouteDto,
  ): Promise<FavoriteTransitRoute> {
    return this.favoriteModel.create({
      user: dto.user,
      label: dto.label,
      origin: {
        name: dto.origin.name,
        coordinates: dto.origin.coordinates,
      },
      destination: {
        name: dto.destination.name,
        coordinates: dto.destination.coordinates,
      },
    });
  }

  async findByUser(userId: Types.ObjectId): Promise<FavoriteTransitRoute[]> {
    return this.favoriteModel
      .find({ user: userId })
      .sort({ createdAt: -1 })
      .exec();
  }

  async findOne(id: Types.ObjectId): Promise<FavoriteTransitRoute> {
    const fav = await this.favoriteModel.findById(id).exec();
    if (!fav) {
      throw new NotFoundException(`Favorite ${id.toString()} not found`);
    }
    return fav;
  }

  async remove(id: Types.ObjectId): Promise<void> {
    const result = await this.favoriteModel.findByIdAndDelete(id).exec();
    if (!result) {
      throw new NotFoundException(`Favorite ${id.toString()} not found`);
    }
  }
}
