const HIGH_SIGNAL = /(?:新(?:人物|角色|目标)|关系(?:改变|变化|破裂|确立)|承诺|答应|约定|必须|目标是|状态(?:改变|变化)|死亡|结婚|加入|离开|获得|失去)/i;

interface TriggerState {
  roundsSinceFlush: number;
  highSignalSeen: boolean;
  armed: boolean;
}

export interface TriggerDecision {
  shouldFlush: boolean;
  reason: 'none' | 'normal_window' | 'high_signal';
  rounds: number;
}

/** 管理每个聊天的 6 轮常规窗口与最早 3 轮高信号窗口。 */
export class AdaptiveIngestTrigger {
  private readonly states = new Map<string, TriggerState>();

  observeRound(chatKey: string, visibleText: string): TriggerDecision {
    const state = this.states.get(chatKey) ?? { roundsSinceFlush: 0, highSignalSeen: false, armed: true };
    state.roundsSinceFlush += 1;
    state.highSignalSeen ||= HIGH_SIGNAL.test(visibleText);
    let reason: TriggerDecision['reason'] = 'none';
    if (state.armed && state.roundsSinceFlush >= 6) reason = 'normal_window';
    else if (state.armed && state.highSignalSeen && state.roundsSinceFlush >= 3) reason = 'high_signal';
    if (reason !== 'none') state.armed = false;
    this.states.set(chatKey, state);
    return { shouldFlush: reason !== 'none', reason, rounds: state.roundsSinceFlush };
  }

  markFlushed(chatKey: string): void {
    this.states.set(chatKey, { roundsSinceFlush: 0, highSignalSeen: false, armed: true });
  }

  reset(chatKey?: string): void {
    if (chatKey) this.states.delete(chatKey);
    else this.states.clear();
  }
}
