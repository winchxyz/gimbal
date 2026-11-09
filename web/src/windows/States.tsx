import { ListSkeleton } from './WindowList.tsx';

/** Loading: the same frame with placeholder bars where the figures go (Markets). */
export function LoadingView() {
  return (
    <div className="w-split" aria-busy="true" aria-label="Loading the markets">
      <section className="w-list">
        <div className="w-head" aria-hidden="true">
          <i className="sk" style={{ width: '80%', height: 52 }} />
          <i className="sk" style={{ width: '50%', height: 52, marginTop: 8 }} />
          <i className="sk" style={{ width: 280, height: 14, marginTop: 20 }} />
        </div>
        <ListSkeleton />
      </section>
      <section className="w-detail w-detail-sk" aria-hidden="true">
        <div className="w-dtop">
          <div>
            <i className="sk" style={{ width: 200, height: 56 }} />
            <i className="sk" style={{ width: 300, height: 18, marginTop: 20 }} />
          </div>
          <div className="n">
            <i className="sk" style={{ width: 220, height: 56, marginLeft: 'auto' }} />
            <i className="sk" style={{ width: 240, height: 18, marginTop: 24, marginLeft: 'auto' }} />
          </div>
        </div>
        <div className="w-chart"><i className="sk" style={{ width: '100%', height: 190 }} /></div>
        <div className="w-cols2">
          <i className="sk" style={{ width: '100%', height: 200 }} />
          <i className="sk" style={{ width: '100%', height: 200 }} />
        </div>
      </section>
    </div>
  );
}
