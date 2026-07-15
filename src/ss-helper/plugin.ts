import {
  API_MAJOR,
  API_MINOR,
  MEMORY_PLUGIN_ID,
  SDK_PACKAGE_VERSION,
  type HostCapability,
  type PluginDescriptor,
  type PluginSession,
} from '@ss-helper/sdk';
import { createMemorySettingsAdapter, MEMORY_SETTINGS_SCHEMA, MEMORY_WORKBENCH_POPUP, type MemorySettingsController } from './settings';
import { registerMemoryServices, type MemoryRecallController } from './services';

export interface MemoryContributionController extends MemorySettingsController, MemoryRecallController {}

export const MEMORY_HOST_CAPABILITIES = Object.freeze([
  'tavern.context.read',
  'tavern.character.read',
  'tavern.persona.read',
  'tavern.chat.read',
  'tavern.chat.events',
  'tavern.worldbooks.read',
  'tavern.prompt.contribute',
  'tavern.plugin.request',
  'tavern.plugin.binary-request.v1',
] as const satisfies readonly HostCapability[]);

export type MemoryHostCapability = (typeof MEMORY_HOST_CAPABILITIES)[number];

export const MEMORY_PLUGIN_DESCRIPTOR: PluginDescriptor<MemoryHostCapability> = Object.freeze({
  id: MEMORY_PLUGIN_ID,
  displayName: 'SS-Helper [记忆]',
  pluginVersion: 'V0.0.2',
  sdkPackageVersion: SDK_PACKAGE_VERSION,
  apiMajor: API_MAJOR,
  minApiMinor: API_MINOR,
  capabilities: MEMORY_HOST_CAPABILITIES,
});

export function registerMemoryContributions(
  session: PluginSession<MemoryHostCapability>,
  controller: MemoryContributionController,
  renderWorkbench: (container: HTMLElement) => void | (() => void),
): { dispose(): void; publishUpdated: ReturnType<typeof registerMemoryServices>['publishUpdated'] } {
  const services = registerMemoryServices(session, controller);
  const disposers = [
    services.dispose,
    session.registerSettings(MEMORY_SETTINGS_SCHEMA, createMemorySettingsAdapter(controller)),
    session.registerPopup({
      token: MEMORY_WORKBENCH_POPUP,
      title: '记忆工作台',
      ariaLabel: 'SS-Helper 记忆工作台',
      render: (container) => renderWorkbench(container),
    }),
  ];
  return {
    publishUpdated: services.publishUpdated,
    dispose() { while (disposers.length > 0) disposers.pop()?.(); },
  };
}
