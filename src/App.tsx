/**
 * 应用装配：全屏画布 + 可拖动浮窗 + 底部工具栏 + 分级界面。
 */
import { useCallback, useEffect, useState } from 'react';
import { Dock } from './components/Dock';
import { FloatingPanel, useIsMobile } from './components/FloatingPanel';
import { HintCard, IntroCard, LegendCard } from './components/Cards';
import { InspectorCard } from './components/InspectorCard';
import { LabCanvas } from './components/LabCanvas';
import { ModelCard } from './components/ModelCard';
import { ResultHUD } from './components/ResultHUD';
import { SettingsCard } from './components/SettingsCard';
import { TopBar, type Level, type PanelFlags } from './components/TopBar';
import { useReducedMotion } from './motion/useReducedMotion';
import { lab } from './state/lab';
import { DEFAULT_PANELS, onUiReset, PANELS_KEY } from './state/uiReset';
import { useLabSnapshot } from './state/useLab';
import './styles/lab.css';

const LEVEL_KEY = 'digitlab-v2-level';
const SEEN_KEY = 'digitlab-v2-seen';

function loadLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveLS(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export default function App() {
  const snap = useLabSnapshot();
  const reduced = useReducedMotion();
  const isMobile = useIsMobile();

  const [level, setLevel] = useState<Level>(() => loadLS<Level>(LEVEL_KEY, 'experience'));
  const [panels, setPanels] = useState<PanelFlags>(() =>
    loadLS<PanelFlags>(PANELS_KEY, { hint: true, result: true, legend: false, settings: false, model: false }),
  );
  const [intro, setIntro] = useState(() => !loadLS<boolean>(SEEN_KEY, false));
  const [samplesOpen, setSamplesOpen] = useState(false);

  useEffect(() => {
    lab().setReduced(reduced);
  }, [reduced]);
  useEffect(() => saveLS(LEVEL_KEY, level), [level]);
  useEffect(() => saveLS(PANELS_KEY, panels), [panels]);
  // 全局复位：浮窗开关回到初始（位置由各浮窗自己订阅复位信号）
  useEffect(
    () =>
      onUiReset(() => {
        setPanels({ ...DEFAULT_PANELS });
        setSamplesOpen(false);
      }),
    [],
  );

  const toggle = useCallback((k: keyof PanelFlags) => setPanels((p) => ({ ...p, [k]: !p[k] })), []);

  const changeLevel = useCallback((l: Level) => {
    setLevel(l);
    setPanels((p) => ({
      ...p,
      hint: l === 'experience' ? p.hint : false,
      settings: l === 'experience' ? false : true,
      model: l === 'expert',
    }));
  }, []);

  const closeIntro = useCallback(() => {
    setIntro(false);
    saveLS(SEEN_KEY, true);
  }, []);

  const panelNodes = (
    <>
      {panels.hint && (
        <FloatingPanel id="hint" title="怎么玩" defaultPos={{ left: 24, top: 92 }} width={300} onClose={() => toggle('hint')} tone="cool">
          <HintCard onOpenSamples={() => setSamplesOpen(true)} />
        </FloatingPanel>
      )}
      {panels.result && (
        <FloatingPanel id="result" title="识别结果" defaultPos={{ right: 24, top: 92 }} width={312} onClose={() => toggle('result')} tone="warm">
          <ResultHUD snap={snap} />
        </FloatingPanel>
      )}
      {snap.inspector && (
        <FloatingPanel
          id="inspector"
          title="神经元检查器"
          defaultPos={{ right: 24, bottom: 116 }}
          width={330}
          onClose={() => lab().onPick(null)}
        >
          <InspectorCard snap={snap} level={level} />
        </FloatingPanel>
      )}
      {level !== 'experience' && panels.settings && (
        <FloatingPanel id="settings" title="参数（探索）" defaultPos={{ left: 24, bottom: 116 }} width={306} onClose={() => toggle('settings')}>
          <SettingsCard snap={snap} />
        </FloatingPanel>
      )}
      {level === 'expert' && panels.model && (
        <FloatingPanel id="model" title="模型与测试（专家）" defaultPos={{ left: 24, top: 92 }} width={340} onClose={() => toggle('model')}>
          <ModelCard snap={snap} />
        </FloatingPanel>
      )}
      {panels.legend && (
        <FloatingPanel id="legend" title="图例与约定" defaultPos={{ left: 24, bottom: 116 }} width={330} onClose={() => toggle('legend')}>
          <LegendCard />
        </FloatingPanel>
      )}
    </>
  );

  return (
    <div className="lab-app">
      <LabCanvas />
      <TopBar level={level} onLevel={changeLevel} panels={panels} onToggle={toggle} snap={snap} />
      {snap.error && <div className="error-bar">模型加载失败：{snap.error}</div>}
      {!isMobile && panelNodes}
      <div className="bottom-stack">
        {isMobile && <div className="sheet-stack">{panelNodes}</div>}
        <Dock snap={snap} samplesOpen={samplesOpen} onSamplesOpen={setSamplesOpen} />
      </div>
      {intro && <IntroCard onClose={closeIntro} />}
    </div>
  );
}
