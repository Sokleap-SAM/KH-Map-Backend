import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { BaseEntity } from '../../../shared/database/base.entity';

export type SearchHistoryDocument = HydratedDocument<SearchHistory>;

@Schema({ timestamps: true, collection: 'search_history' })
export class SearchHistory extends BaseEntity {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ required: true, type: String })
  placeId: string;

  @Prop({ required: true, type: String })
  name: string;

  @Prop({ required: true, type: String, default: 'Place' })
  categoryName: string;

  @Prop({ required: true, type: Number })
  latitude: number;

  @Prop({ required: true, type: Number })
  longitude: number;

  @Prop({ type: Date, default: Date.now })
  searchedAt: Date;
}

export const SearchHistorySchema = SchemaFactory.createForClass(SearchHistory);
SearchHistorySchema.index({ userId: 1, searchedAt: -1 });
