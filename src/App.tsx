import { useRoute } from './router';
import { LibraryView } from './views/LibraryView';
import { PlayerView } from './views/PlayerView';
import { EditorView } from './views/EditorView';
import { DrillView } from './views/DrillView';
import { TunerView } from './views/TunerView';
import { SheetView } from './views/SheetView';

export function App() {
  const route = useRoute();
  switch (route.name) {
    case 'play': return <PlayerView key={route.id} id={route.id} />;
    case 'edit': return <EditorView id={route.id} />;
    case 'new': return <EditorView id={null} />;
    case 'drill': return <DrillView initial={route.chords} />;
    case 'tuner': return <TunerView />;
    case 'sheet': return <SheetView id={route.id} />;
    default: return <LibraryView />;
  }
}
