/* eslint-disable max-lines */
import {
  addBreadcrumb,
  getActiveSpan,
  setMeasurement,
  SPAN_STATUS_OK,
  spanToJSON,
  startInactiveSpan,
} from '@sentry/core';
import type { Span } from '@sentry/types';
import { logger, timestampInSeconds } from '@sentry/utils';

import type { NewFrameEvent } from '../utils/sentryeventemitter';
import { type SentryEventEmitter, createSentryEventEmitter, NewFrameEventName } from '../utils/sentryeventemitter';
import { isSentrySpan } from '../utils/span';
import { RN_GLOBAL_OBJ } from '../utils/worldwide';
import { NATIVE } from '../wrapper';
import type { OnConfirmRoute, TransactionCreator } from './routingInstrumentation';
import { InternalRoutingInstrumentation } from './routingInstrumentation';
import { manualInitialDisplaySpans, startTimeToInitialDisplaySpan } from './timetodisplay';
import type { BeforeNavigate } from './types';

export interface NavigationRoute {
  name: string;
  key: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params?: Record<string, any>;
}

interface NavigationContainer {
  addListener: (type: string, listener: () => void) => void;
  getCurrentRoute: () => NavigationRoute;
}

interface ReactNavigationOptions {
  /**
   * How long the instrumentation will wait for the route to mount after a change has been initiated,
   * before the transaction is discarded.
   * Time is in ms.
   *
   * @default 1000
   */
  routeChangeTimeoutMs: number;

  /**
   * Time to initial display measures the time it takes from
   * navigation dispatch to the render of the first frame of the new screen.
   *
   * @default false
   */
  enableTimeToInitialDisplay: boolean;
}

const defaultOptions: ReactNavigationOptions = {
  routeChangeTimeoutMs: 1000,
  enableTimeToInitialDisplay: false,
};

/**
 * Instrumentation for React-Navigation V5 and above. See docs or sample app for usage.
 *
 * How this works:
 * - `_onDispatch` is called every time a dispatch happens and sets an IdleTransaction on the scope without any route context.
 * - `_onStateChange` is then called AFTER the state change happens due to a dispatch and sets the route context onto the active transaction.
 * - If `_onStateChange` isn't called within `STATE_CHANGE_TIMEOUT_DURATION` of the dispatch, then the transaction is not sampled and finished.
 */
export class ReactNavigationInstrumentation extends InternalRoutingInstrumentation {
  public static instrumentationName: string = 'react-navigation-v5';

  public readonly name: string = ReactNavigationInstrumentation.instrumentationName;

  private _navigationContainer: NavigationContainer | null = null;
  private _newScreenFrameEventEmitter: SentryEventEmitter | null = null;

  private readonly _maxRecentRouteLen: number = 200;

  private _latestRoute?: NavigationRoute;
  private _latestTransaction?: Span;
  private _navigationProcessingSpan?: Span;

  private _initialStateHandled: boolean = false;
  private _stateChangeTimeout?: number | undefined;
  private _recentRouteKeys: string[] = [];

  private _options: ReactNavigationOptions;

  public constructor(options: Partial<ReactNavigationOptions> = {}) {
    super();

    this._options = {
      ...defaultOptions,
      ...options,
    };

    if (this._options.enableTimeToInitialDisplay) {
      this._newScreenFrameEventEmitter = createSentryEventEmitter();
      this._newScreenFrameEventEmitter.initAsync(NewFrameEventName);
      NATIVE.initNativeReactNavigationNewFrameTracking().catch((reason: unknown) => {
        logger.error(`[ReactNavigationInstrumentation] Failed to initialize native new frame tracking: ${reason}`);
      });
    }
  }

  /**
   * Extends by calling _handleInitialState at the end.
   */
  public registerRoutingInstrumentation(
    listener: TransactionCreator,
    beforeNavigate: BeforeNavigate,
    onConfirmRoute: OnConfirmRoute,
  ): void {
    super.registerRoutingInstrumentation(listener, beforeNavigate, onConfirmRoute);

    // We create an initial state here to ensure a transaction gets created before the first route mounts.
    if (!this._initialStateHandled) {
      this._onDispatch();
      if (this._navigationContainer) {
        // Navigation container already registered, just populate with route state
        this._onStateChange();

        this._initialStateHandled = true;
      }
    }
  }

  /**
   * Pass the ref to the navigation container to register it to the instrumentation
   * @param navigationContainerRef Ref to a `NavigationContainer`
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-module-boundary-types
  public registerNavigationContainer(navigationContainerRef: any): void {
    /* We prevent duplicate routing instrumentation to be initialized on fast refreshes

      Explanation: If the user triggers a fast refresh on the file that the instrumentation is
      initialized in, it will initialize a new instance and will cause undefined behavior.
     */
    if (!RN_GLOBAL_OBJ.__sentry_rn_v5_registered) {
      if ('current' in navigationContainerRef) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        this._navigationContainer = navigationContainerRef.current;
      } else {
        this._navigationContainer = navigationContainerRef;
      }

      if (this._navigationContainer) {
        this._navigationContainer.addListener(
          '__unsafe_action__', // This action is emitted on every dispatch
          this._onDispatch.bind(this),
        );
        this._navigationContainer.addListener(
          'state', // This action is emitted on every state change
          this._onStateChange.bind(this),
        );

        if (!this._initialStateHandled) {
          if (this._latestTransaction) {
            // If registerRoutingInstrumentation was called first _onDispatch has already been called
            this._onStateChange();

            this._initialStateHandled = true;
          } else {
            logger.log(
              '[ReactNavigationInstrumentation] Navigation container registered, but integration has not been setup yet.',
            );
          }
        }

        RN_GLOBAL_OBJ.__sentry_rn_v5_registered = true;
      } else {
        logger.warn('[ReactNavigationInstrumentation] Received invalid navigation container ref!');
      }
    } else {
      logger.log(
        '[ReactNavigationInstrumentation] Instrumentation already exists, but register has been called again, doing nothing.',
      );
    }
  }

  /**
   * To be called on every React-Navigation action dispatch.
   * It does not name the transaction or populate it with route information. Instead, it waits for the state to fully change
   * and gets the route information from there, @see _onStateChange
   */
  private _onDispatch(): void {
    if (this._latestTransaction) {
      logger.log(
        '[ReactNavigationInstrumentation] A transaction was detected that turned out to be a noop, discarding.',
      );
      this._discardLatestTransaction();
      this._clearStateChangeTimeout();
    }

    this._latestTransaction = this.onRouteWillChange({ name: 'Route Change' });

    if (this._options.enableTimeToInitialDisplay) {
      this._navigationProcessingSpan = startInactiveSpan({
        op: 'navigation.processing',
        name: 'Navigation processing',
        startTime: this._latestTransaction && spanToJSON(this._latestTransaction).start_timestamp,
      });
    }

    this._stateChangeTimeout = setTimeout(
      this._discardLatestTransaction.bind(this),
      this._options.routeChangeTimeoutMs,
    );
  }

  /**
   * To be called AFTER the state has been changed to populate the transaction with the current route.
   */
  private _onStateChange(): void {
    const stateChangedTimestamp = timestampInSeconds();

    // Use the getCurrentRoute method to be accurate.
    const previousRoute = this._latestRoute;

    if (!this._navigationContainer) {
      logger.warn(
        '[ReactNavigationInstrumentation] Missing navigation container ref. Route transactions will not be sent.',
      );

      return;
    }

    const route = this._navigationContainer.getCurrentRoute();

    if (route) {
      if (this._latestTransaction) {
        if (!previousRoute || previousRoute.key !== route.key) {
          const routeHasBeenSeen = this._recentRouteKeys.includes(route.key);
          const latestTtidSpan =
            !routeHasBeenSeen &&
            this._options.enableTimeToInitialDisplay &&
            startTimeToInitialDisplaySpan({
              name: `${route.name} initial display`,
              isAutoInstrumented: true,
            });

          !routeHasBeenSeen &&
            this._newScreenFrameEventEmitter?.once(
              NewFrameEventName,
              ({ newFrameTimestampInSeconds }: NewFrameEvent) => {
                const activeSpan = getActiveSpan();
                if (!activeSpan) {
                  logger.warn(
                    '[ReactNavigationInstrumentation] No active span found to attach ui.load.initial_display to.',
                  );
                  return;
                }

                if (manualInitialDisplaySpans.has(activeSpan)) {
                  logger.warn(
                    '[ReactNavigationInstrumentation] Detected manual instrumentation for the current active span.',
                  );
                  return;
                }

                if (!latestTtidSpan) {
                  return;
                }

                if (spanToJSON(latestTtidSpan).parent_span_id !== getActiveSpan()?.spanContext().spanId) {
                  logger.warn(
                    '[ReactNavigationInstrumentation] Currently Active Span changed before the new frame was rendered, _latestTtidSpan is not a child of the currently active span.',
                  );
                  return;
                }

                latestTtidSpan.setStatus({ code: SPAN_STATUS_OK });
                latestTtidSpan.end(newFrameTimestampInSeconds);
                const ttidSpan = spanToJSON(latestTtidSpan);

                const ttidSpanEnd = ttidSpan.timestamp;
                const ttidSpanStart = ttidSpan.start_timestamp;
                if (!ttidSpanEnd || !ttidSpanStart) {
                  return;
                }

                setMeasurement('time_to_initial_display', (ttidSpanEnd - ttidSpanStart) * 1000, 'millisecond');
              },
            );

          this._navigationProcessingSpan?.updateName(`Processing navigation to ${route.name}`);
          this._navigationProcessingSpan?.setStatus({ code: SPAN_STATUS_OK });
          this._navigationProcessingSpan?.end(stateChangedTimestamp);
          this._navigationProcessingSpan = undefined;

          this._latestTransaction.updateName(route.name);
          this._latestTransaction.setAttributes({
            'route.name': route.name,
            'route.key': route.key,
            // TODO: filter PII params instead of dropping them all
            // 'route.params': {},
            'route.has_been_seen': routeHasBeenSeen,
            'previous_route.name': previousRoute?.name,
            'previous_route.key': previousRoute?.key,
            // TODO: filter PII params instead of dropping them all
            // 'previous_route.params': {},
          });

          // TODO: route name tag is replaces by event.contexts.app.view_names

          // TODO: Should we remove beforeNavigation callback or change it to be compatible with V8?
          // Clear the timeout so the transaction does not get cancelled.
          this._clearStateChangeTimeout();

          // TODO: Remove onConfirmRoute when `context.view_names` are set directly in the navigation instrumentation
          this._onConfirmRoute?.(route.name);

          // TODO: Add test for addBreadcrumb
          addBreadcrumb({
            category: 'navigation',
            type: 'navigation',
            message: `Navigation to ${route.name}`,
            data: {
              from: previousRoute?.name,
              to: route.name,
            },
          });
        }

        this._pushRecentRouteKey(route.key);
        this._latestRoute = route;

        // Clear the latest transaction as it has been handled.
        this._latestTransaction = undefined;
      }
    }
  }

  /** Pushes a recent route key, and removes earlier routes when there is greater than the max length */
  private _pushRecentRouteKey = (key: string): void => {
    this._recentRouteKeys.push(key);

    if (this._recentRouteKeys.length > this._maxRecentRouteLen) {
      this._recentRouteKeys = this._recentRouteKeys.slice(this._recentRouteKeys.length - this._maxRecentRouteLen);
    }
  };

  /** Cancels the latest transaction so it does not get sent to Sentry. */
  private _discardLatestTransaction(): void {
    if (this._latestTransaction) {
      if (isSentrySpan(this._latestTransaction)) {
        this._latestTransaction['_sampled'] = false;
      }
      // TODO: What if it's not SentrySpan?
      this._latestTransaction.end();
      this._latestTransaction = undefined;
    }
    if (this._navigationProcessingSpan) {
      this._navigationProcessingSpan = undefined;
    }
  }

  /**
   *
   */
  private _clearStateChangeTimeout(): void {
    if (typeof this._stateChangeTimeout !== 'undefined') {
      clearTimeout(this._stateChangeTimeout);
      this._stateChangeTimeout = undefined;
    }
  }
}

/**
 * Backwards compatibility alias for ReactNavigationInstrumentation
 * @deprecated Use ReactNavigationInstrumentation
 */
export const ReactNavigationV5Instrumentation = ReactNavigationInstrumentation;

export const BLANK_TRANSACTION_CONTEXT = {
  name: 'Route Change',
  op: 'navigation',
  tags: {
    'routing.instrumentation': ReactNavigationInstrumentation.instrumentationName,
  },
  data: {},
};
