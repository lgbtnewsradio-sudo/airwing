// MediaStreamTrackProcessor is shipped in Chromium but not yet in lib.dom.d.ts.
interface MediaStreamVideoTrack extends MediaStreamTrack {}
interface MediaStreamAudioTrack extends MediaStreamTrack {}

interface MediaStreamTrackProcessorInit<T extends MediaStreamTrack = MediaStreamTrack> {
  track: T;
  maxBufferSize?: number;
}

declare class MediaStreamTrackProcessor<T = VideoFrame | AudioData> {
  constructor(init: MediaStreamTrackProcessorInit);
  readonly readable: ReadableStream<T>;
}
