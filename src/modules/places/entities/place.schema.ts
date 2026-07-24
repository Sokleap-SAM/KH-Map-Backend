import { Prop, raw, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { BaseEntity } from '../../../shared/database/base.entity';

export type PlaceDocument = HydratedDocument<Place>;

export type GeoJsonPoint = {
  type: 'Point';
  coordinates: [number, number]; // [longitude, latitude]
};

/**
 * Approval state of a place. User-submitted places start as `pending` and only
 * appear on the public map once an admin sets them to `approved`. `rejected`
 * places stay in the collection (hidden from the map) so the submitter can see
 * the outcome. Admin-created stops and legacy docs are treated as `approved`.
 */
export enum PlaceStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
}

@Schema({ timestamps: true, collection: 'places' })
export class Place extends BaseEntity {
  @Prop({ required: true, type: String })
  nameInKhmer: string;

  @Prop({ required: true, type: String })
  nameInLatin: string;

  @Prop({ type: Types.ObjectId, ref: 'PlaceCategory', default: null })
  category: Types.ObjectId | null;

  // Approval state. Defaults to APPROVED so admin/internal creates and legacy
  // documents stay visible; user requests explicitly override this to PENDING.
  @Prop({
    type: String,
    enum: PlaceStatus,
    default: PlaceStatus.APPROVED,
    index: true,
  })
  status: PlaceStatus;

  // The user who submitted this place (null for admin/internal creates).
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  createdBy: Types.ObjectId | null;

  // Audit trail for the admin review action. Set together when an admin
  // approves/rejects a pending request, so they identify request-originated
  // places (admin-created stops and legacy docs never go through review and
  // keep these null) and back the admin review-history view.
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  reviewedBy: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  reviewedAt: Date | null;

  // Why an admin rejected this request, written at reject time so the submitter
  // can see what to fix and re-submit. Null for pending/approved places (cleared
  // on approve so a re-approved place carries no stale reason).
  @Prop({ type: String, default: null })
  rejectionReason: string | null;

  @Prop(
    raw({
      type: { type: String, enum: ['Point'], required: true },
      coordinates: { type: [Number], required: true },
    }),
  )
  location: GeoJsonPoint;

  @Prop({ type: Number, default: null })
  ratingCount: number | null;

  @Prop({ type: Number, min: 1.0, max: 5.0, default: null })
  averageRating: number | null;

  @Prop({ required: false, type: [String], default: [] })
  photos: string[];
}

export const PlaceSchema = SchemaFactory.createForClass(Place);
PlaceSchema.index({ location: '2dsphere' });
