/* eslint-disable @typescript-eslint/no-unsafe-enum-comparison */
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppSetting, AppSettingDocument } from './entities/app-setting.schema';
import { TransitMode } from './enums/transit-mode.enum';

const TRANSIT_MODE_KEY = 'transit.mode';

/**
 * How often each instance re-reads the mode from Mongo.
 *
 * The cache exists so per-tick reads in the simulator and dispatch don't hit
 * the database. It used to be invalidated only by setMode(), which was correct
 * on a single instance but silently wrong once the API runs more than one task:
 * a PATCH lands on exactly one of them, and every other task keeps a stale
 * cache until it restarts. The cluster then disagrees with the database —
 * `requireLiveMode()` rejects about half of driver requests, and a stale
 * instance holding the simulation lock carries on moving simulated buses after
 * an admin has switched to live.
 *
 * Polling is the cheapest fix that needs no new infrastructure: one findOne per
 * task per interval, and it bounds the disagreement to this window.
 */
const MODE_REFRESH_MS = 5_000;

@Injectable()
export class AppSettingsService implements OnModuleInit, OnModuleDestroy {
  // In-memory cache so per-tick mode reads in the simulator and dispatch
  // services don't hit Mongo. Kept fresh by setMode() on this instance and by
  // the refresh timer on every other one.
  private modeCache: TransitMode = TransitMode.SIMULATION;
  private refreshHandle: ReturnType<typeof setInterval> | null = null;

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

    this.refreshHandle = setInterval(
      () => void this.refreshMode(),
      MODE_REFRESH_MS,
    );
    // Don't keep the event loop alive on shutdown — ECS sends SIGTERM and then
    // SIGKILL, and a pending interval would delay a clean exit for no reason.
    this.refreshHandle.unref?.();
  }

  onModuleDestroy(): void {
    if (this.refreshHandle) {
      clearInterval(this.refreshHandle);
      this.refreshHandle = null;
    }
  }

  getMode(): TransitMode {
    return this.modeCache;
  }

  /**
   * Re-read the stored mode into the cache. Swallows errors deliberately: a
   * transient Mongo failure must leave the last known mode in place rather
   * than silently reverting the whole fleet's behaviour to the default.
   */
  private async refreshMode(): Promise<void> {
    try {
      const doc = await this.appSettingModel
        .findOne({ key: TRANSIT_MODE_KEY })
        .lean()
        .exec();
      if (doc) this.modeCache = this.parseMode(doc.value);
    } catch {
      /* keep the last known value */
    }
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
