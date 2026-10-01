import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { BaseEntity } from '../../../shared/database/base.entity';

export type PlaceCategoryDocument = HydratedDocument<PlaceCategory>;

@Schema({ timestamps: true, collection: 'place_categories' })
export class PlaceCategory extends BaseEntity {
  @Prop({ required: true, type: String })
  name: string;
}

export const PlaceCategorySchema = SchemaFactory.createForClass(PlaceCategory);
