type State = { isActive: boolean };
type Listener = { remove: () => Promise<void> };
type NativeApp = { addListener: (event: 'appStateChange', callback: (state: State) => void) => Promise<Listener>; getState: () => Promise<State> };

export function shouldTrackStudy(visibility: string, nativeActive: boolean, accountFenced: boolean) {
  return visibility === 'visible' && nativeActive && !accountFenced;
}

/** Start closed until the native lifecycle is known. An older getState result
 * cannot override a more recent background/foreground event. */
export function watchNativeStudyActivity(app: NativeApp, update: (active: boolean) => void) {
  let cancelled=false, revision=0, listener: Listener | undefined;
  void (async()=>{
    try {
      const handle=await app.addListener('appStateChange',state=>{revision++;if(!cancelled)update(state.isActive);});
      if(cancelled){await handle.remove();return;}listener=handle;
      const before=revision,state=await app.getState();if(!cancelled&&before===revision)update(state.isActive);
    } catch { if(!cancelled)update(false); }
  })();
  return()=>{cancelled=true;void listener?.remove();};
}
