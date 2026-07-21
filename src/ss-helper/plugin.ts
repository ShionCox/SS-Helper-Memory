import {
  API_MAJOR,
  API_MINOR,
  MEMORY_PLUGIN_ID,
  SDK_PACKAGE_VERSION,
  type HostCapability,
  type PopupUiContext,
  type PluginDescriptor,
  type PluginSession,
  type WorkspaceRecoveryRepairResult,
} from '@ss-helper/sdk';
import { createMemorySettingsAdapter, MEMORY_SETTINGS_SCHEMA, MEMORY_WORKBENCH_POPUP, type MemorySettingsController, type MemorySettingsStatusSource } from './settings';
import { registerMemoryServices, type MemoryRecallController } from './services';
import { renderMemoryWorkspaceRecovery, type MemoryWorkspaceRecoveryController } from '../ui/workspace-recovery-ui';
import config from '../../plugin.config.json' with { type: 'json' };

export interface MemoryContributionController extends MemorySettingsController, MemoryRecallController {}

export const MEMORY_HOST_CAPABILITIES = Object.freeze([
  'tavern.context.read',
  'core.ui.notification.v1',
  'tavern.character.read',
  'tavern.persona.read',
  'tavern.chat.read',
  'tavern.chat.events',
  'tavern.worldbooks.read',
  'tavern.prompt.contribute',
  'tavern.plugin.request',
  'tavern.plugin.binary-request.v1',
  'workspace.recovery',
] as const satisfies readonly HostCapability[]);

export type MemoryHostCapability = (typeof MEMORY_HOST_CAPABILITIES)[number];

export const MEMORY_WORKSPACE_RECOVERY_POPUP = Object.freeze({
  kind: 'popup' as const,
  provider: MEMORY_PLUGIN_ID,
  name: 'workspace-recovery',
  version: 1,
});

export interface MemoryRecoveryController extends MemoryWorkspaceRecoveryController {
  repair(): Promise<WorkspaceRecoveryRepairResult>;
}

export const MEMORY_PLUGIN_DESCRIPTOR: PluginDescriptor<MemoryHostCapability> = Object.freeze({
  id: MEMORY_PLUGIN_ID,
  displayName: config.displayName,
  settingsDisplayName: config.settingsDisplayName,
  pluginVersion: config.manifest.version,
  sdkPackageVersion: SDK_PACKAGE_VERSION,
  apiMajor: API_MAJOR,
  minApiMinor: API_MINOR,
  capabilities: MEMORY_HOST_CAPABILITIES,
});

export function registerMemoryContributions(
  session: PluginSession<MemoryHostCapability>,
  controller: MemoryContributionController,
  renderWorkbench: (container: HTMLElement, actionId: string | undefined, popupUi?: PopupUiContext) => void | (() => void),
  statusSource: MemorySettingsStatusSource,
  recovery: MemoryRecoveryController,
): { dispose(): void; publishUpdated: ReturnType<typeof registerMemoryServices>['publishUpdated'] } {
  const services = registerMemoryServices(session, controller);
  const disposers = [
    services.dispose,
    session.registerSettings(MEMORY_SETTINGS_SCHEMA, createMemorySettingsAdapter(controller, statusSource, (notification) => session.ui.showToast(notification))),
    session.registerPopup({
      token: MEMORY_WORKBENCH_POPUP,
      title: '记忆工作台',
      ariaLabel: 'SS-Helper 记忆工作台',
      closeLabel: '关闭记忆工作台',
      presentation: 'workspace',
      render: (container, input, popupUi) => {
        const actionId = input && typeof input === 'object' && !Array.isArray(input)
          && typeof (input as { actionId?: unknown }).actionId === 'string'
          ? (input as { actionId: string }).actionId
          : undefined;
        return renderWorkbench(container, actionId, popupUi);
      },
    }),
    session.registerPopup({
      token: MEMORY_WORKSPACE_RECOVERY_POPUP,
      title: 'Memory 工作区恢复',
      ariaLabel: 'SS-Helper Memory 工作区恢复',
      closeLabel: '稍后处理 Memory 工作区恢复',
      presentation: 'workspace',
      render: (container, input, popupUi) => renderMemoryWorkspaceRecovery(
        container,
        {
          errorCode: input && typeof input === 'object' && !Array.isArray(input)
            && typeof (input as Record<string, unknown>).errorCode === 'string'
            ? (input as Record<string, string>).errorCode
            : undefined,
        },
        recovery,
        (notification) => session.ui.showToast(notification),
        popupUi,
      ),
    }),
  ];
  return {
    publishUpdated: services.publishUpdated,
    dispose() { while (disposers.length > 0) disposers.pop()?.(); },
  };
}
