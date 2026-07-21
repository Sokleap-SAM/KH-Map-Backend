import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { Place, PlaceSchema } from './entities/place.schema';
import {
  PlaceCategory,
  PlaceCategorySchema,
} from './entities/place-category.schema';
import { PlaceRating, PlaceRatingSchema } from './entities/place-rating.schema';
import { PlaceController } from './place.controller';
import { PlaceService } from './place.service';
import { PlaceCategoryService } from './place-category.service';
import { PlaceRatingService } from './place-rating.service';
import { RolesGuard } from '../../common/guards/roles.guard';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Place.name, schema: PlaceSchema },
      { name: PlaceCategory.name, schema: PlaceCategorySchema },
      { name: PlaceRating.name, schema: PlaceRatingSchema },
    ]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
  ],
  controllers: [PlaceController],
  providers: [
    PlaceService,
    PlaceCategoryService,
    PlaceRatingService,
    RolesGuard,
  ],
  exports: [PlaceService, PlaceCategoryService, PlaceRatingService],
})
export class PlaceModule {}
