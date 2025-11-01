/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise, disposableTimeout, raceTimeout } from '../../../../../base/common/async.js';
import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { isNumber, isObject } from '../../../../../base/common/types.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { PromptInputState } from '../../../../../platform/terminal/common/capabilities/commandDetection/promptInputModel.js';
import { ITerminalLogService, ITerminalProfile, TerminalSettingId, type IShellLaunchConfig } from '../../../../../platform/terminal/common/terminal.js';
import { ITerminalService, type ITerminalInstance } from '../../../terminal/browser/terminal.js';
import { getShellIntegrationTimeout } from '../../../terminal/common/terminalEnvironment.js';

const enum ShellLaunchType {
	Unknown = 0,
	Default = 1,
	Fallback = 2,
}

export const enum ShellIntegrationQuality {
	None = 'none',
	Basic = 'basic',
	Rich = 'rich',
}

export interface IToolTerminal {
	instance: ITerminalInstance;
	shellIntegrationQuality: ShellIntegrationQuality;
	receivedUserInput?: boolean;
}

export class ToolTerminalCreator {
	/**
	 * The shell preference cached for the lifetime of the window. This allows skipping previous
	 * shell approaches that failed in previous runs to save time.
	 */
	private static _lastSuccessfulShell: ShellLaunchType = ShellLaunchType.Unknown;

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@ITerminalLogService private readonly _logService: ITerminalLogService,
		@ITerminalService private readonly _terminalService: ITerminalService,
	) {
	}

	async createTerminal(shellOrProfile: string | ITerminalProfile, token: CancellationToken): Promise<IToolTerminal> {
		const startTime = Date.now();
		this._logService.debug(`ToolTerminalCreator#createTerminal: Starting terminal creation, shell/profile: ${typeof shellOrProfile === 'string' ? shellOrProfile : JSON.stringify(shellOrProfile)}`);

		const instance = await this._createCopilotTerminal(shellOrProfile);
		const toolTerminal: IToolTerminal = {
			instance,
			shellIntegrationQuality: ShellIntegrationQuality.None,
		};
		let processReadyTimestamp = 0;

		// Ensure the shell process launches successfully
		this._logService.debug(`ToolTerminalCreator#createTerminal: Waiting for process to be ready`);
		const initResult = await Promise.any([
			instance.processReady.then(() => {
				processReadyTimestamp = Date.now();
				this._logService.debug(`ToolTerminalCreator#createTerminal: Process ready after ${processReadyTimestamp - startTime}ms`);
				return processReadyTimestamp;
			}),
			Event.toPromise(instance.onExit),
		]);
		if (!isNumber(initResult) && isObject(initResult) && 'message' in initResult) {
			this._logService.error(`ToolTerminalCreator#createTerminal: Process exited with error: ${initResult.message}`);
			throw new Error(initResult.message);
		}

		// Wait for shell integration when the fallback case has not been hit or when shell
		// integration injection is enabled. Note that it's possible for the fallback case to happen
		// and then for SI to activate again later in the session.
		const siInjectionEnabled = this._configurationService.getValue(TerminalSettingId.ShellIntegrationEnabled) === true;
		this._logService.debug(`ToolTerminalCreator#createTerminal: Shell integration injection enabled: ${siInjectionEnabled}`);

		// Get the configurable timeout to wait for shell integration
		const waitTime = getShellIntegrationTimeout(
			this._configurationService,
			siInjectionEnabled,
			instance.hasRemoteAuthority,
			processReadyTimestamp
		);

		if (
			ToolTerminalCreator._lastSuccessfulShell !== ShellLaunchType.Fallback ||
			siInjectionEnabled
		) {
			this._logService.info(`ToolTerminalCreator#createTerminal: Waiting ${waitTime}ms for shell integration (process ready timestamp: ${processReadyTimestamp})`);
			const shellIntegrationQuality = await this._waitForShellIntegration(instance, waitTime);
			const detectionTime = Date.now() - startTime;
			this._logService.info(`ToolTerminalCreator#createTerminal: Shell integration quality detected as '${shellIntegrationQuality}' after ${detectionTime}ms`);

			if (token.isCancellationRequested) {
				this._logService.debug(`ToolTerminalCreator#createTerminal: Cancellation requested, disposing terminal`);
				instance.dispose();
				throw new CancellationError();
			}

			// If SI is rich, wait for the prompt state to change. This prevents an issue with pwsh
			// in particular where shell startup can swallow `\r` input events, preventing the
			// command from executing.
			if (shellIntegrationQuality === ShellIntegrationQuality.Rich) {
				const commandDetection = instance.capabilities.get(TerminalCapability.CommandDetection);
				const currentState = commandDetection?.promptInputModel.state;
				this._logService.debug(`ToolTerminalCreator#createTerminal: Rich SI detected, prompt input state: ${currentState}`);
				if (commandDetection?.promptInputModel.state === PromptInputState.Unknown) {
					this._logService.info(`ToolTerminalCreator#createTerminal: Waiting up to 2s for PromptInputModel state to change`);
					await raceTimeout(Event.toPromise(commandDetection.onCommandStarted), 2000);
					this._logService.debug(`ToolTerminalCreator#createTerminal: PromptInputModel state wait completed`);
				}
			}

			if (shellIntegrationQuality !== ShellIntegrationQuality.None) {
				ToolTerminalCreator._lastSuccessfulShell = ShellLaunchType.Default;
				toolTerminal.shellIntegrationQuality = shellIntegrationQuality;
				this._logService.info(`ToolTerminalCreator#createTerminal: Terminal created successfully with shell integration quality: ${shellIntegrationQuality}`);
				return toolTerminal;
			}
		} else {
			this._logService.info(`ToolTerminalCreator#createTerminal: Skipping wait for shell integration - last successful launch type ${ToolTerminalCreator._lastSuccessfulShell}`);
		}

		// Fallback case: No shell integration in default profile
		ToolTerminalCreator._lastSuccessfulShell = ShellLaunchType.Fallback;
		this._logService.warn(`ToolTerminalCreator#createTerminal: Falling back to no shell integration`);
		return toolTerminal;
	}

	/**
	 * Synchronously update shell integration quality based on the terminal instance's current
	 * capabilities. This is a defensive change to avoid no shell integration being sticky
	 * https://github.com/microsoft/vscode/issues/260880
	 *
	 * Only upgrade quality just in case.
	 */
	refreshShellIntegrationQuality(toolTerminal: IToolTerminal) {
		const commandDetection = toolTerminal.instance.capabilities.get(TerminalCapability.CommandDetection);
		const previousQuality = toolTerminal.shellIntegrationQuality;
		if (commandDetection) {
			if (
				toolTerminal.shellIntegrationQuality === ShellIntegrationQuality.None ||
				toolTerminal.shellIntegrationQuality === ShellIntegrationQuality.Basic
			) {
				const newQuality = commandDetection.hasRichCommandDetection ? ShellIntegrationQuality.Rich : ShellIntegrationQuality.Basic;
				if (newQuality !== toolTerminal.shellIntegrationQuality) {
					this._logService.info(`ToolTerminalCreator#refreshShellIntegrationQuality: Upgrading shell integration quality from ${previousQuality} to ${newQuality}`);
					toolTerminal.shellIntegrationQuality = newQuality;
				}
			}
		} else {
			this._logService.debug(`ToolTerminalCreator#refreshShellIntegrationQuality: No command detection capability available, quality remains ${previousQuality}`);
		}
	}

	private _createCopilotTerminal(shellOrProfile: string | ITerminalProfile) {
		const config: IShellLaunchConfig = {
			icon: ThemeIcon.fromId(Codicon.chatSparkle.id),
			hideFromUser: true,
			forcePersist: true,
			env: {
				// Avoid making `git diff` interactive when called from copilot
				GIT_PAGER: 'cat',
			}
		};

		if (typeof shellOrProfile === 'string') {
			config.executable = shellOrProfile;
		} else {
			config.executable = shellOrProfile.path;
			config.args = shellOrProfile.args;
			config.icon = shellOrProfile.icon ?? config.icon;
			config.color = shellOrProfile.color;
			config.env = {
				...config.env,
				...shellOrProfile.env
			};
		}

		return this._terminalService.createTerminal({ config });
	}

	private _waitForShellIntegration(
		instance: ITerminalInstance,
		timeoutMs: number
	): Promise<ShellIntegrationQuality> {
		const startTime = Date.now();
		this._logService.debug(`ToolTerminalCreator#_waitForShellIntegration: Starting wait, timeout: ${timeoutMs}ms`);

		const store = new DisposableStore();
		const result = new DeferredPromise<ShellIntegrationQuality>();

		const siNoneTimer = store.add(new MutableDisposable());
		siNoneTimer.value = disposableTimeout(() => {
			const elapsed = Date.now() - startTime;
			this._logService.info(`ToolTerminalCreator#_waitForShellIntegration: Timed out after ${elapsed}ms (timeout was ${timeoutMs}ms), using no SI`);
			const commandDetectionAtTimeout = instance.capabilities.get(TerminalCapability.CommandDetection);
			this._logService.debug(`ToolTerminalCreator#_waitForShellIntegration: Current command detection state - exists: ${commandDetectionAtTimeout ? 'yes' : 'no'}, hasRichCommandDetection: ${commandDetectionAtTimeout?.hasRichCommandDetection ?? 'N/A'}`);
			result.complete(ShellIntegrationQuality.None);
		}, timeoutMs);

		const initialCommandDetection = instance.capabilities.get(TerminalCapability.CommandDetection);
		if (initialCommandDetection?.hasRichCommandDetection) {
			// Rich command detection is available immediately.
			siNoneTimer.clear();
			const elapsed = Date.now() - startTime;
			this._logService.info(`ToolTerminalCreator#_waitForShellIntegration: Rich SI available immediately (after ${elapsed}ms)`);
			result.complete(ShellIntegrationQuality.Rich);
		} else {
			this._logService.debug(`ToolTerminalCreator#_waitForShellIntegration: Initial state - commandDetection: ${initialCommandDetection ? 'exists' : 'null'}, hasRichCommandDetection: ${initialCommandDetection?.hasRichCommandDetection ?? 'N/A'}`);

			const onSetRichCommandDetection = store.add(this._terminalService.createOnInstanceCapabilityEvent(TerminalCapability.CommandDetection, e => e.onSetRichCommandDetection));
			store.add(onSetRichCommandDetection.event((e) => {
				if (e.instance !== instance) {
					this._logService.debug(`ToolTerminalCreator#_waitForShellIntegration: Rich command detection event for different instance, ignoring`);
					return;
				}
				siNoneTimer.clear();
				const elapsed = Date.now() - startTime;
				// Rich command detection becomes available some time after the terminal is created.
				this._logService.info(`ToolTerminalCreator#_waitForShellIntegration: Rich SI available eventually (after ${elapsed}ms)`);
				result.complete(ShellIntegrationQuality.Rich);
			}));

			const commandDetection = instance.capabilities.get(TerminalCapability.CommandDetection);
			if (commandDetection) {
				siNoneTimer.clear();
				this._logService.debug(`ToolTerminalCreator#_waitForShellIntegration: Command detection exists but no rich detection yet, waiting 500ms for rich detection`);
				// When SI lights up, allow up to 500ms for the rich command
				// detection sequence to come in before declaring it as basic shell integration.
				// Increased from 200ms to 500ms to give zsh more time to send HasRichCommandDetection sequence.
				const basicSiTimer = disposableTimeout(() => {
					const elapsed = Date.now() - startTime;
					const hasRichNow = instance.capabilities.get(TerminalCapability.CommandDetection)?.hasRichCommandDetection;
					if (hasRichNow) {
						this._logService.info(`ToolTerminalCreator#_waitForShellIntegration: Rich detection received during wait (after ${elapsed}ms), upgrading to Rich SI`);
						result.complete(ShellIntegrationQuality.Rich);
					} else {
						this._logService.info(`ToolTerminalCreator#_waitForShellIntegration: Timed out 500ms after command detection (total ${elapsed}ms), using basic SI`);
						result.complete(ShellIntegrationQuality.Basic);
					}
				}, 500);
				store.add(basicSiTimer);
			} else {
				this._logService.debug(`ToolTerminalCreator#_waitForShellIntegration: No command detection yet, setting up listener`);
				store.add(instance.capabilities.onDidAddCommandDetectionCapability(e => {
					if (e !== instance.capabilities.get(TerminalCapability.CommandDetection)) {
						return;
					}
					const elapsed = Date.now() - startTime;
					this._logService.debug(`ToolTerminalCreator#_waitForShellIntegration: Command detection capability added after ${elapsed}ms`);
					siNoneTimer.clear();
					// When command detection lights up, allow up to 500ms for the rich command
					// detection sequence to come in before declaring it as basic shell
					// integration. Increased from 200ms to 500ms to give zsh more time.
					const basicSiTimer = disposableTimeout(() => {
						const totalElapsed = Date.now() - startTime;
						const hasRichNow = instance.capabilities.get(TerminalCapability.CommandDetection)?.hasRichCommandDetection;
						if (hasRichNow) {
							this._logService.info(`ToolTerminalCreator#_waitForShellIntegration: Rich detection received during wait (after ${totalElapsed}ms), upgrading to Rich SI (via listener)`);
							result.complete(ShellIntegrationQuality.Rich);
						} else {
							this._logService.info(`ToolTerminalCreator#_waitForShellIntegration: Timed out 500ms after capability added (total ${totalElapsed}ms), using basic SI (via listener)`);
							result.complete(ShellIntegrationQuality.Basic);
						}
					}, 500);
					store.add(basicSiTimer);
				}));
			}
		}

		result.p.finally(() => {
			const elapsed = Date.now() - startTime;
			this._logService.info(`ToolTerminalCreator#_waitForShellIntegration: Promise complete after ${elapsed}ms, disposing store`);
			store.dispose();
		});

		return result.p;
	}
}
