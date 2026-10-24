// The center pane's three views (design reference §6.1; spec D3): the graph, the guided review and
// the file-by-file diff, behind tabs. What every view shares (the selection and comments, and
// progress when it comes) lives in ReviewProvider above them, so it is the same in all three. A
// hidden view is kept by <Activity>, not unmounted, so the canvas keeps its expanded groups and
// dragged nodes and the diffs their expanded context. Showing a view again re-runs its effects,
// which bring the current selection into view.
import { Activity, type ReactNode, useState } from 'react';
import { Canvas } from './Canvas.tsx';
import { Files } from './Files.tsx';
import { Guided } from './Guided.tsx';

const VIEWS = [
  { id: 'graph', label: 'Graph', view: <Canvas /> },
  { id: 'guided', label: 'Guided', view: <Guided /> },
  { id: 'files', label: 'Files', view: <Files /> },
] as const satisfies readonly { id: string; label: string; view: ReactNode }[];

export function Views() {
  const [shown, setShown] = useState<(typeof VIEWS)[number]['id']>('graph');
  return (
    <div className="views">
      <div className="view-tabs" role="tablist" aria-label="Views">
        {VIEWS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={id === shown}
            onClick={() => setShown(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {VIEWS.map(({ id, view }) => (
        <Activity key={id} mode={id === shown ? 'visible' : 'hidden'}>
          {view}
        </Activity>
      ))}
    </div>
  );
}
