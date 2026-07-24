/* eslint-disable @typescript-eslint/no-unsafe-enum-comparison */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppSetting, AppSettingDocument } from './entities/app-setting.schema';
import { TransitMode } from './enums/transit-mode.enum';

const TRANSIT_MODE_KEY = 'transit.mode';

@Injectable()
export class AppSettingsService implements OnModuleInit {
  // In-memory cache so per-tick mode reads in the simulator and dispatch
  // services don't hit Mongo. Refreshed only on explicit setMode() — there's
  // no other writer.
  private modeCache: TransitMode = TransitMode.SIMULATION;

  constructor(
    @InjectModel(AppSetting.name)
    private readonly appSettingModel: Model<AppSettingDocument>,
  ) {}

  async onModuleInit(): Promise<void> {
    const doc = await this.appSettingModel
      .findOne({ key: TRANSIT_MODE_KEY })
      .exec();
    if (!doc) {
      // Seed with simulation so a fresh deploy keeps its current behaviour
      // until an admin explicitly flips. Upsert so concurrent boots are safe.
      await this.appSettingModel
        .updateOne(
          { key: TRANSIT_MODE_KEY },
          { $setOnInsert: { value: TransitMode.SIMULATION } },
          { upsert: true },
        )
        .exec();
      this.modeCache = TransitMode.SIMULATION;
    } else {
      this.modeCache = this.parseMode(doc.value);
    }
  }

  getMode(): TransitMode {
    return this.modeCache;
  }

  async setMode(mode: TransitMode): Promise<TransitMode> {
    await this.appSettingModel
      .updateOne(
        { key: TRANSIT_MODE_KEY },
        { $set: { value: mode } },
        { upsert: true },
      )
      .exec();
    this.modeCache = mode;
    return mode;
  }

  private parseMode(raw: string): TransitMode {
    return raw === TransitMode.LIVE ? TransitMode.LIVE : TransitMode.SIMULATION;
  }
}
