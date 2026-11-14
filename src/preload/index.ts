import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AgentEvent,
  ApprovalDecision,
  ChatMessage,
  ForceStopResult,
  LogEntry,
  MonitorSample,
  OptionValues,
  PitcherEvent,
  RendererApi,
  ServerActivity,
  ServerLogEvent
} from '@shared/types'

// The only bridge between the sandboxed renderer and the Node-privileged main
// process. Keep this surface small and explicit , the renderer can do nothing
// the methods below don't allow.
const api: RendererApi = {
  // Read from the --app-debug=<0|1> argument injected via webPreferences
  // additionalArguments, so the renderer knows the debug flag synchronously.
  debug: process.argv.some((a) => a === '--app-debug=1'),

  // The OS the app runs on, so the Pantry can show platform-specific defaults.
  platform: process.platform,

  sendMessage(messages: ChatMessage[]): Promise<void> {
    return ipcRenderer.invoke('agent:send', messages)
  },

  cancelMessage(): void {
    ipcRenderer.send('agent:cancel')
  },

  influenceMessage(id, content, interrupt): Promise<boolean> {
    return ipcRenderer.invoke('agent:influence', id, content, interrupt)
  },

  getPathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  listTools() {
    return ipcRenderer.invoke('agent:list-tools')
  },

  getThinkingPhrases() {
    return ipcRenderer.invoke('agent:thinking-phrases')
  },

  onAgentEvent(handler: (event: AgentEvent) => void): () => void {
    const listener = (_event: unknown, payload: AgentEvent): void => handler(payload)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  },

  onServersChanged(handler: () => void): () => void {
    const listener = (): void => handler()
    ipcRenderer.on('servers:changed', listener)
    return () => ipcRenderer.removeListener('servers:changed', listener)
  },

  respondApproval(id: string, decision: ApprovalDecision): void {
    ipcRenderer.send('agent:approve', id, decision)
  },

  setBypassApprovals(enabled: boolean): void {
    ipcRenderer.send('agent:set-bypass', enabled)
  },

  respondStepLimit(id: string, cont: boolean): void {
    ipcRenderer.send('agent:continue', id, cont)
  },

  respondNapkinChoice(id: string, choiceId: string): void {
    ipcRenderer.send('agent:napkin-choice', id, choiceId)
  },

  respondPitcherProposal(id: string, result: { saved: boolean; name: string }): void {
    ipcRenderer.send('agent:pitcher-proposal-result', id, result)
  },

  setSpeak(enabled: boolean): Promise<boolean> {
    return ipcRenderer.invoke('agent:set-speak', enabled)
  },

  getSpeak(): Promise<boolean> {
    return ipcRenderer.invoke('agent:get-speak')
  },

  transcribe(audioBase64: string, mimeType: string): Promise<string> {
    return ipcRenderer.invoke('agent:transcribe', audioBase64, mimeType)
  },

  cancelTranscribe(): void {
    ipcRenderer.send('agent:cancel-transcribe')
  },

  getAppVersion(): Promise<string> {
    return ipcRenderer.invoke('app:version')
  },

  checkHealth(): Promise<boolean> {
    return ipcRenderer.invoke('agent:check-health')
  },

  getServerActivity(): Promise<ServerActivity> {
    return ipcRenderer.invoke('agent:server-activity')
  },

  forceStop(): Promise<ForceStopResult> {
    return ipcRenderer.invoke('agent:force-stop')
  },

  getConnection() {
    return ipcRenderer.invoke('agent:get-connection')
  },

  setConnection(opts: { baseUrl: string; apiKey: string }) {
    return ipcRenderer.invoke('agent:set-connection', opts)
  },

  getContextInfo() {
    return ipcRenderer.invoke('agent:context-info')
  },

  getContextBreakdown(history: ChatMessage[]) {
    return ipcRenderer.invoke('agent:context-breakdown', history)
  },

  compactHistory(history: ChatMessage[]) {
    return ipcRenderer.invoke('agent:compact', history)
  },

  setContextSize(ctxSize: number) {
    return ipcRenderer.invoke('agent:set-context', ctxSize)
  },

  setMaxCompletionTokens(tokens: number) {
    return ipcRenderer.invoke('agent:set-max-completion-tokens', tokens)
  },

  listModels() {
    return ipcRenderer.invoke('agent:list-models')
  },

  loadModel(id: string, ctxSize?: number) {
    return ipcRenderer.invoke('agent:load-model', id, ctxSize)
  },

  unloadModel(id: string) {
    return ipcRenderer.invoke('agent:unload-model', id)
  },

  downloadModel(id: string) {
    return ipcRenderer.invoke('agent:download-model', id)
  },

  listDownloads() {
    return ipcRenderer.invoke('agent:list-downloads')
  },

  controlDownload(id: string, action: 'pause' | 'cancel' | 'remove') {
    return ipcRenderer.invoke('agent:control-download', id, action)
  },

  deleteModel(id: string) {
    return ipcRenderer.invoke('agent:delete-model', id)
  },

  listCatalog() {
    return ipcRenderer.invoke('catalog:list')
  },

  listServers() {
    return ipcRenderer.invoke('servers:list')
  },

  configureServer(
    id: string,
    opts: { enabled: boolean; path?: string; options?: OptionValues }
  ) {
    return ipcRenderer.invoke('servers:configure', id, opts)
  },

  removeServer(id: string) {
    return ipcRenderer.invoke('servers:remove', id)
  },

  pickPath(kind: 'folder' | 'file') {
    return ipcRenderer.invoke('dialog:pick-path', kind)
  },

  listSessions() {
    return ipcRenderer.invoke('history:list')
  },

  loadSession(id: string) {
    return ipcRenderer.invoke('history:load', id)
  },

  saveSession(session) {
    return ipcRenderer.invoke('history:save', session)
  },

  deleteSession(id: string) {
    return ipcRenderer.invoke('history:delete', id)
  },

  renameSession(id: string, title: string) {
    return ipcRenderer.invoke('history:rename', id, title)
  },

  clearSessions() {
    return ipcRenderer.invoke('history:clear')
  },

  suggestTitle(history: ChatMessage[]) {
    return ipcRenderer.invoke('history:suggest-title', history)
  },

  listPitchers() {
    return ipcRenderer.invoke('pitcher:list')
  },

  savePitcher(pitcher) {
    return ipcRenderer.invoke('pitcher:save', pitcher)
  },

  deletePitcher(id: string) {
    return ipcRenderer.invoke('pitcher:delete', id)
  },

  runPitcher(id: string) {
    return ipcRenderer.invoke('pitcher:run', id)
  },

  cancelPitcher(id: string) {
    return ipcRenderer.invoke('pitcher:cancel', id)
  },

  onPitcherEvent(handler: (event: PitcherEvent) => void): () => void {
    const listener = (_event: unknown, payload: PitcherEvent): void => handler(payload)
    ipcRenderer.on('pitcher:event', listener)
    return () => ipcRenderer.removeListener('pitcher:event', listener)
  },

  listRecipes() {
    return ipcRenderer.invoke('recipe:list')
  },

  saveRecipe(recipe) {
    return ipcRenderer.invoke('recipe:save', recipe)
  },

  deleteRecipe(id: string) {
    return ipcRenderer.invoke('recipe:delete', id)
  },

  setRecipeEnabled(id: string, enabled: boolean) {
    return ipcRenderer.invoke('recipe:set-enabled', id, enabled)
  },

  importRecipes() {
    return ipcRenderer.invoke('recipe:import')
  },

  exportRecipe(id: string) {
    return ipcRenderer.invoke('recipe:export', id)
  },

  minimizeWindow(): void {
    ipcRenderer.send('window:minimize')
  },

  toggleMaximizeWindow(): void {
    ipcRenderer.send('window:toggle-maximize')
  },

  closeWindow(): void {
    ipcRenderer.send('window:close')
  },

  async openFolderInExplorer(folderPath: string): Promise<void> {
    return await ipcRenderer.invoke('explorer:open-folder', folderPath)
  },

  getAppLogs() {
    return ipcRenderer.invoke('logs:app-get')
  },

  onAppLog(handler: (entry: LogEntry) => void): () => void {
    const listener = (_event: unknown, payload: LogEntry): void => handler(payload)
    ipcRenderer.on('logs:app-entry', listener)
    // The main process only forwards new lines while someone is listening, so
    // the app's own (chatty) logging costs nothing when no viewer is open.
    ipcRenderer.send('logs:app-subscribe')
    return () => {
      ipcRenderer.removeListener('logs:app-entry', listener)
      ipcRenderer.send('logs:app-unsubscribe')
    }
  },

  revealAppLogFile(): Promise<boolean> {
    return ipcRenderer.invoke('logs:reveal-app-file')
  },

  onServerLog(handler: (event: ServerLogEvent) => void): () => void {
    const listener = (_event: unknown, payload: ServerLogEvent): void => handler(payload)
    ipcRenderer.on('logs:server-event', listener)
    // Subscribing opens the server's log stream; closing the viewer closes it.
    ipcRenderer.send('logs:server-subscribe')
    return () => {
      ipcRenderer.removeListener('logs:server-event', listener)
      ipcRenderer.send('logs:server-unsubscribe')
    }
  },

  onMonitorSample(handler: (sample: MonitorSample) => void): () => void {
    const listener = (_event: unknown, payload: MonitorSample): void => handler(payload)
    ipcRenderer.on('monitor:sample', listener)
    // Polling only runs while the Monitor is open.
    ipcRenderer.send('monitor:subscribe')
    return () => {
      ipcRenderer.removeListener('monitor:sample', listener)
      ipcRenderer.send('monitor:unsubscribe')
    }
  },

  popOutMonitor(position?: { x: number; y: number }): Promise<void> {
    return ipcRenderer.invoke('monitor:pop-out', position)
  },

  focusMonitorWindow(): Promise<boolean> {
    return ipcRenderer.invoke('monitor:focus-window')
  }
}

contextBridge.exposeInMainWorld('api', api)
