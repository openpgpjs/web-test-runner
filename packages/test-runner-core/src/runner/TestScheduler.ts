import { createSessionUrl } from './createSessionUrl.js';
import { TestRunnerCoreConfig } from '../config/TestRunnerCoreConfig.js';
import { TestSessionManager } from '../test-session/TestSessionManager.js';
import { TestSession, TestResultError } from '../test-session/TestSession.js';
import { SESSION_STATUS } from '../test-session/TestSessionStatus.js';
import { withTimeout } from '../utils/async.js';
import { TestSessionTimeoutHandler } from './TestSessionTimeoutHandler.js';
import { BrowserLauncher } from '../browser-launcher/BrowserLauncher.js';

export class TestScheduler {
  private config: TestRunnerCoreConfig;
  private sessions: TestSessionManager;
  private timeoutHandler: TestSessionTimeoutHandler;
  private browsers: BrowserLauncher[];
  private finishedBrowsers = new Set<BrowserLauncher>();
  private stopPromises = new Set<Promise<unknown>>();
  private browserStartTimeoutMsg: string;
  private testsStartTimeoutRetriesPerSession: { [sessionID: string]: number };

  constructor(
    config: TestRunnerCoreConfig,
    sessions: TestSessionManager,
    browsers: BrowserLauncher[],
  ) {
    this.config = config;
    this.sessions = sessions;
    this.testsStartTimeoutRetriesPerSession = {};
    this.browsers = [...browsers].sort(
      (a, b) => (a.__experimentalWindowFocus__ ? 1 : 0) - (b.__experimentalWindowFocus__ ? 1 : 0),
    );
    this.timeoutHandler = new TestSessionTimeoutHandler(this.config, this.sessions, this);
    this.browserStartTimeoutMsg =
      `The browser was unable to create and start a test page after ${this.config.browserStartTimeout}ms. ` +
      'You can increase this timeout with the browserStartTimeout option.';

    sessions.on('session-status-updated', async session => {
      if (session.status === SESSION_STATUS.TEST_STARTED) {
        this.timeoutHandler.waitForTestsFinished(session.testRun, session.id);
        return;
      }

      if (session.status === SESSION_STATUS.TEST_FINISHED) {
        // the session finished executing tests, close the browser page
        await this.stopSession(session);
        return;
      }

      if (session.status === SESSION_STATUS.FINISHED) {
        this.timeoutHandler.clearTimeoutsForSession(session);

        setTimeout(() => {
          // run next scheduled after a timeout, so that other actors on status change can
          // do their work first
          this.runNextScheduled();
        });
      }
    });
  }

  /**
   * Schedules a session for execution. Execution is batched, the session
   * will be queued until there is a browser page available.
   */
  schedule(testRun: number, sessionsToSchedule: Iterable<TestSession>) {
    for (const session of sessionsToSchedule) {
      this.sessions.updateStatus(
        { ...session, testRun, request404s: [] },
        SESSION_STATUS.SCHEDULED,
      );
    }
    this.runNextScheduled();
  }

  stop(): Promise<unknown> {
    this.timeoutHandler.clearAllTimeouts();
    return Promise.all(Array.from(this.stopPromises));
  }

  /** Runs the next batch of scheduled sessions, if any. */
  private runNextScheduled() {
    let runningBrowsers = 0;

    for (const browser of this.browsers) {
      if (runningBrowsers >= 1 && browser.__experimentalWindowFocus__) {
        return;
      }

      if (runningBrowsers >= this.config.concurrentBrowsers) {
        // do not boot up more than the allowed concurrent browsers
        return;
      }

      const unfinishedCount = this.getUnfinishedSessions(browser).length;
      if (unfinishedCount > 0) {
        // this browser has not finished running all tests
        runningBrowsers += 1;

        const runningCount = this.getRunningSessions(browser).length;
        let maxBudget;

        if (browser.__experimentalWindowFocus__) {
          maxBudget = 1;
        } else {
          maxBudget = browser.concurrency ?? this.config.concurrency;
        }

        const runBudget = Math.max(0, maxBudget - runningCount);
        if (runBudget !== 0) {
          // we have budget to schedule new sessions for this browser
          const allScheduled = this.getScheduledSessions(browser);
          const toRun = allScheduled.slice(0, runBudget);
          for (const session of toRun) {
            this.startSession(session);
          }
        }
      }
    }
  }

  private async startSession(session: TestSession) {
    const updatedSession = { ...session, status: SESSION_STATUS.INITIALIZING };
    this.sessions.updateStatus(updatedSession, SESSION_STATUS.INITIALIZING);
    let browserStarted = false;

    // browser should be started within the specified milliseconds
    const timeoutId = setTimeout(() => {
      if (!browserStarted && !this.timeoutHandler.isStale(updatedSession)) {
        this.setSessionFailed(this.sessions.get(updatedSession.id)!, {
          message: this.browserStartTimeoutMsg,
        });
      }
    }, this.config.browserStartTimeout!);
    this.timeoutHandler.addTimeoutId(updatedSession.id, timeoutId);

    try {
      await withTimeout(
        updatedSession.browser.startSession(
          updatedSession.id,
          createSessionUrl(this.config, updatedSession),
        ),
        this.browserStartTimeoutMsg,
        this.config.browserStartTimeout,
      );

      // when the browser started, wait for session to ping back on time
      this.timeoutHandler.waitForTestsStarted(updatedSession.testRun, updatedSession.id);
    } catch (e) {
      const error = e as Error;
      if (this.timeoutHandler.isStale(updatedSession)) {
        // something else has changed the test session, such as a the browser timeout
        // or a re-run in watch mode. in that was we just log the error
        if (error.message !== this.browserStartTimeoutMsg) {
          this.config.logger.error(error);
        }
      } else {
        this.setSessionFailed(updatedSession, { message: error.message, stack: error.stack });
      }
    } finally {
      browserStarted = true;
    }
  }

  setSessionFailed(session: TestSession, ...errors: TestResultError[]) {
    // retry mechanism for browserstack failing to start tests due to server disconnect, for unclear reasons.
    if (this.config.testsStartTimeoutMaxRetries &&
        errors.some(error => error.message.includes('testsStartTimeout'))) {
      if (this.testsStartTimeoutRetriesPerSession[session.id] === undefined) {
        this.testsStartTimeoutRetriesPerSession[session.id] = 0;
      }
      if (this.testsStartTimeoutRetriesPerSession[session.id]++ < this.config.testsStartTimeoutMaxRetries) {
          console.log(`restarting session after testsStartTimeout (retry #${this.testsStartTimeoutRetriesPerSession[session.id]})`);
          return session.browser.stop!()
            .then(async () => {
              await session.browser.initialize!(this.config, /* unused arg, needed for TS */[])
              await this.startSession(session);
            }).catch(error => {
              console.error('error restarting session', error);
            });
      }
    }

    this.stopSession(session, errors);
  }

  private async stopSession(session: TestSession, errors: TestResultError[] = []) {
    if (this.timeoutHandler.isStale(session)) {
      return;
    }
    const sessionErrors = [...errors];
    const updatedSession = { ...session };

    try {
      if (session.browser.isActive(session.id)) {
        const { testCoverage, errors } = await withTimeout(
          session.browser.stopSession(session.id),
          'Timed out stopping the browser page',
          this.config.testsFinishTimeout,
        );
        updatedSession.errors = [...(updatedSession.errors ?? []), ...(errors ?? [])];
        updatedSession.testCoverage = testCoverage;
      }
    } catch (error) {
      sessionErrors.push(error as Error);
    } finally {
      if (sessionErrors.length > 0) {
        // merge with existing erors
        updatedSession.errors = [...(updatedSession.errors ?? []), ...sessionErrors];
        updatedSession.passed = false;
      }

      this.sessions.updateStatus(updatedSession, SESSION_STATUS.FINISHED);

      const remaining = this.getUnfinishedSessions(session.browser);

      if (
        !this.config.watch &&
        !this.finishedBrowsers.has(session.browser) &&
        remaining.length === 0
      ) {
        if (session.browser.stop) {
          this.finishedBrowsers.add(session.browser);
          const stopPromise = session.browser
            .stop()
            .catch(error => {
              console.error(error);
            })
            .then(() => {
              this.stopPromises.delete(stopPromise);
            });
          this.stopPromises.add(stopPromise);
        }
      }
    }
  }

  private getScheduledSessions(browser: BrowserLauncher) {
    return Array.from(
      this.sessions.filtered(s => s.browser === browser && s.status === SESSION_STATUS.SCHEDULED),
    );
  }

  private getRunningSessions(browser: BrowserLauncher) {
    return Array.from(
      this.sessions.filtered(
        s =>
          s.browser === browser &&
          [
            SESSION_STATUS.INITIALIZING,
            SESSION_STATUS.TEST_STARTED,
            SESSION_STATUS.TEST_FINISHED,
          ].includes(s.status),
      ),
    );
  }

  private getUnfinishedSessions(browser: BrowserLauncher) {
    return Array.from(
      this.sessions.filtered(s => s.browser === browser && s.status !== SESSION_STATUS.FINISHED),
    );
  }
}
