import { HydratedDocument, Types } from 'mongoose';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { BaseEntity } from '../../../shared/database/base.entity';
import { UserRole, UserStatus } from '../enums/role.enum';

export type UserDocument = HydratedDocument<User>;

@Schema({
  timestamps: true,
  collection: 'users',
})
export class User extends BaseEntity {
  @Prop({ required: true })
  name!: string;

  @Prop({ required: true, unique: true })
  email!: string;

  @Prop({ required: true })
  password!: string;

  @Prop({
    type: String,
    enum: UserRole,
    default: UserRole.USER,
  })
  role!: UserRole;

  // Only meaningful for drivers — riders/admins ignore this.
  @Prop({
    type: String,
    enum: UserStatus,
    default: UserStatus.OFF,
  })
  status!: UserStatus;

  // Admin-assigned bus a driver operates. Trips on this bus are the only ones
  // the driver can start/cancel; MQTT credentials are issued against this link.
  @Prop({ type: Types.ObjectId, ref: 'Bus', default: null })
  assignedBusId?: Types.ObjectId | null;

  // bcrypt hash of the driver's MQTT broker password. The plaintext is shown
  // exactly once when the driver app calls GET /drivers/me/mqtt-credentials —
  // we never store or display it again. Rotated whenever credentials are
  // re-issued. Mosquitto's auth plugin compares against this hash via the
  // /internal/mqtt-auth endpoints.
  @Prop({ type: String, default: null })
  mqttPasswordHash?: string | null;
}

export const UserSchema = SchemaFactory.createForClass(User);
