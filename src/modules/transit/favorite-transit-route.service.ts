import {
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import {
  FavoriteTransitRoute,
  FavoriteTransitRouteDocument,
} from './entities/favorite-transit-route.schema';
import { CreateFavoriteTransitRouteDto } from './dto/create-favorite-transit-route.dto';
import { TransitRoutingService } from './transit-routing.service';

@Injectable()
export class FavoriteTransitRouteService {
  constructor(
    @InjectModel(FavoriteTransitRoute.name)
    private readonly favoriteModel: Model<FavoriteTransitRouteDocument>,
    private readonly transitRoutingService: TransitRoutingService,
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
      legs: dto.legs.map((l) => ({
        route: l.route,
        boardStop: l.boardStop,
        alightStop: l.alightStop,
      })),
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

  /**
   * Rebuild the saved skeleton into a live, option-shaped payload by recomputing
   * walk legs (Valhalla) and bus ETAs (live + anchored). Throws 410 Gone when any
   * referenced route or stop no longer exists, signalling the frontend that the
   * favorite is stale and should be re-saved from a fresh plan.
   */
  async openLive(id: Types.ObjectId) {
    const fav = await this.findOne(id);
    const option = await this.transitRoutingService.replanFromSkeleton({
      origin: fav.origin.coordinates,
      destination: fav.destination.coordinates,
      legs: fav.legs.map((l) => ({
        routeId: l.route.toString(),
        boardStopId: l.boardStop.toString(),
        alightStopId: l.alightStop.toString(),
      })),
    });
    if (!option) {
      throw new GoneException(
        'This favorite refers to routes or stops that no longer exist. Re-save it from a fresh plan.',
      );
    }
    return {
      found: true as const,
      type: 'transit' as const,
      favoriteId: fav._id.toString(),
      label: fav.label ?? null,
      origin: fav.origin,
      destination: fav.destination,
      option,
    };
  }
}
