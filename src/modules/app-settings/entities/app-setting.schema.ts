import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { BaseEntity } from '../../../shared/database/base.entity';

export type AppSettingDocument = HydratedDocument<AppSetting>;

// Generic key-value settings collection. One document per key. Reserved keys
// live in AppSettingsService — schema deliberately doesn't enumerate them so
// new flags can be added without a migration.
@Schema({ timestamps: true, collection: 'app_settings' })
export class AppSetting extends BaseEntity {
  @Prop({ required: true, unique: true, type: String })
  key!: string;

  @Prop({ required: true, type: String })
  value!: string;
}

export const AppSettingSchema = SchemaFactory.createForClass(AppSetting);
