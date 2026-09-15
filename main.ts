import {
    App,
    MarkdownRenderer,
    Menu,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    moment
} from 'obsidian';
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { RangeSetBuilder, StateEffect } from '@codemirror/state';

// --- Internal Canvas Interfaces ---
interface CanvasNode {
    id: string;
    text?: string;
    file?: TFile;
    color?: string;
    x?: number;
    y?: number;
    from?: any;
    to?: any;
    unknownData?: { type: string };
    setAttributes?: (attrs: any) => void;
    // 卡片編輯狀態下，內部承載這張卡片的 MarkdownEditView 子元件；.editor 是標準的 Obsidian Editor
    child?: { editor?: any };
    // 這張卡片在 DOM 上對應的容器元素，用來從一個 DOM 事件反查是哪一個 node（未公開屬性）
    nodeEl?: HTMLElement;
    canvas: any;
}

interface CanvasEdge {
    id: string;
    from: { node: CanvasNode };
    to: { node: CanvasNode };
}

// --- 拖曳分割卡片 (Heptabase-style Drag-to-Split) ---
// 實測確認：macOS 三指拖曳這種輔助功能模擬出來的手勢，沒辦法「按住已選取的文字」觸發 mousedown
// （這件事連 Obsidian 原生編輯器本身都做不到，是系統/Electron 層級的限制，不是本外掛的問題）。
// 因此除了原本「按下滑鼠時，位置剛好落在選取範圍內」這個觸發點之外，
// 額外提供第二種觸發方式：游標移到選取範圍上「停留」一小段時間（HOVER_ARM_DELAY_MS）也會觸發，
// 不需要真的按下按鍵——這樣不管輸入裝置能不能正確送出 mousedown，都能觸發後續的拖曳追蹤
const HOVER_ARM_DELAY_MS = 10;
// 三指拖曳放開後，物理手勢不一定是乾淨俐落的單一瞬間——手指陸續離開觸控板時，
// 系統可能還會再送出幾個 buttons 仍是 1 的殘留移動事件。如果這些殘留事件剛好經過
// 另一段已經穩定的選取文字，會被誤判成「使用者要抓取另一段」而立刻重新 arm，
// 造成放開後手掌圖案沒有消失、還無端多建立一張卡片。手勢結束後的這段冷卻時間內，
// 完全不允許重新 arm，讓物理放開動作有機會真正結束
const GESTURE_COOLDOWN_MS = 400;

interface DragGestureState {
    canvas: any;
    sourceNode: CanvasNode;
    editor: any;
    from: any;
    to: any;
    text: string;
    startX: number;
    startY: number;
    dragging: boolean;
}

// 卡片參照 token：`((card:<id>))`，只存目標卡片的 canvas node id，顯示用的標題在渲染當下即時查詢，
// 這樣標題裡巢狀的 `inline code`/`$math$`/`**bold**` 才能正常渲染，且目標卡片改內容後參照會跟著更新
const CARD_REF_REGEX = /\(\(card:([A-Za-z0-9_-]+)\)\)/g;
// 用來通知「其他卡片的文字可能變了，請重新渲染你的 ((card:id)) chip」，本身不帶任何文件異動
const refreshCardRefs = StateEffect.define<void>();

// --- Settings ---
interface CanvasCardMaterializerSettings {
    exportPath: string;
}

const DEFAULT_SETTINGS: CanvasCardMaterializerSettings = {
    exportPath: 'Exports/Canvas'
};

export default class CanvasCardMaterializer extends Plugin {
    settings: CanvasCardMaterializerSettings;
    private patchedCanvas = false;
    private originalAddNode: Function | null = null;
    private patchedCanvasConstructor: any = null;
    // 避免同一張 canvas 在前一次 materialize 尚未跑完（含兩段式 setData 的 100ms 延遲）時被重疊觸發
    private processingCanvases: Set<string> = new Set();
    // 拖曳分割卡片：記住觸發當下選取的文字/位置，mouseup 時才判斷是否真的觸發了拖曳
    private dragGesture: DragGestureState | null = null;
    // 游標停留在選取範圍上待觸發的計時器 id（尚未真正 arm 之前的「醞釀」狀態）
    private hoverArmTimer: number | null = null;
    // 記錄每個卡片編輯器「已經穩定存在（沒有按著任何鍵時就已經是這樣）」的選取範圍，
    // 用來分辨「使用者正在拖曳框選新文字」（選取範圍還在變動，buttons 也是 1，但不該觸發拖曳分割）
    // 跟「使用者重新按著一段早就選好、已經靜止的文字」（才是真正要抓取搬移的手勢）。
    // 連同當時的文字內容一起記錄（不只是 offset），比對時兩者都要吻合——
    // 否則一旦拖曳完成把原文字換成 ((card:id)) chip，offset 剛好對得上的話會被舊紀錄誤判成
    // 「還是同一段既有選取」，導致同一段內容被重複抓取、重複建立新卡片
    private settledSelections = new WeakMap<EditorView, { from: number; to: number; text: string }>();
    // 「這個 CM6 view 是不是 canvas 卡片」的判斷快取——這個 handler 對 Obsidian 裡所有編輯器都會
    // 觸發（不只是 canvas），判斷本身要逐一比對所有開啟中 canvas 的 nodes，不便宜，
    // 不能在高頻率的 mousemove 裡每次都重算；同一個 view 生命週期內這個答案不會變，只需要算一次
    private isCanvasCardViewCache = new WeakMap<EditorView, boolean>();
    // 上一次手勢真正結束（放開/取消）的時間戳，配合 GESTURE_COOLDOWN_MS 擋掉放開後的殘留觸發事件
    private lastGestureEndTime = 0;
    // 用同一個函式參照才能正確 add/removeEventListener 成對
    private boundHandleMouseMove = (evt: MouseEvent) => this.handleCardMouseMove(evt);
    private boundHandleMouseUp = (evt: MouseEvent) => this.handleCardMouseUp(evt);
    // 目前畫面上所有 canvas 卡片編輯器的 CM6 view，任何一張卡片文字變動時用來廣播刷新彼此的 ((card:id)) chip
    private activeCardRefEditors: Set<EditorView> = new Set();

    async onload() {
        await this.loadSettings();

        // 1. 設定面板
        this.addSettingTab(new CanvasCardMaterializerSettingTab(this.app, this));

        // 2. 註冊選單 (同時支援單選與多選)
        // 監聽多選選單
        this.registerEvent(
            this.app.workspace.on('canvas:selection-menu' as any, (menu: Menu, canvas: any) => {
                this.addMaterializeMenuItem(menu, canvas);
            })
        );

        // 監聽單一節點選單 (修正你說單一 block 沒選項的問題)
        this.registerEvent(
            this.app.workspace.on('canvas:node-menu' as any, (menu: Menu, node: any) => {
                this.addMaterializeMenuItem(menu, node.canvas);
            })
        );

        // 3. 實作 Canvas 猴子補丁 (Monkey-patch) 攔截節點加入事件
        this.app.workspace.onLayoutReady(() => {
            this.patchCanvasConstructor();
        });

        // 4. 監聽自定義事件：自動處理拉入檔案的顏色同步
        this.registerEvent(
            this.app.workspace.on('canvas:node:added' as any, (canvas: any, node: CanvasNode) => {
                setTimeout(async () => {
                    if (node.file instanceof TFile && node.file.extension === 'md') {
                        const fileCache = this.app.metadataCache.getFileCache(node.file);
                        const savedColor = fileCache?.frontmatter?.['canvas_color'];
                        
                        if (savedColor !== undefined && savedColor !== null) {
                            const colorStr = String(savedColor); 
                            
                            if (typeof node.setAttributes === 'function') {
                                node.setAttributes({ color: colorStr }); 
                            } else {
                                node.color = colorStr;
                            }
                            
                            if (typeof (node as any).render === 'function') {
                                (node as any).render();
                            }
                            canvas.requestSave();
                        }
                    }
                }, 150);
            })
        );

        // 5. 拖曳選取文字分割成新卡片 (Heptabase-style Drag-to-Split)
        // 實測發現：卡片進入編輯模式後，CM6 會在它自己的 DOM 節點上處理 mousedown，事件不會冒泡到
        // document（不管 capture 或 bubble 階段都攔不到）。正確做法是透過 CM6 官方的
        // EditorView.domEventHandlers()，直接掛進 CM6 自己的事件處理管線，而不是在外面用 document 監聽器硬攔
        this.registerEditorExtension(this.buildDragHandlerExtension());
        this.registerEditorExtension(this.buildCardRefViewPlugin());
        // 卡片在「未聚焦/唯讀」狀態下不是走 CM6 即時編輯畫面，上面那個 ViewPlugin 不會生效，
        // ((card:id)) 只會顯示成純文字。額外用官方的 registerMarkdownPostProcessor 補上同一套
        // chip 渲染，讓卡片不管有沒有被點進去編輯，參照都能正常顯示
        this.registerMarkdownPostProcessor((el) => this.processCardRefsInElement(el));
        // 未聚焦/唯讀狀態下的 chip 是 registerMarkdownPostProcessor 渲染出來的一次性靜態內容，
        // 不會像 CM6 那邊一樣自動偵測到「目標卡片內容變了」而重新渲染。已 materialize 成檔案的
        // 卡片，chip 標題目前是用檔名（node.file.basename）顯示，改檔名或改內容都不會自動反映在
        // 還沒被重新渲染過的舊 chip 上——因此額外監聽檔案改名/修改事件，主動找出畫面上所有指向
        // 該卡片的 chip 元素就地重新渲染
        this.registerEvent(this.app.vault.on('rename', (file) => {
            if (file instanceof TFile) this.refreshCardRefsForFile(file);
        }));
        this.registerEvent(this.app.vault.on('modify', (file) => {
            if (file instanceof TFile) this.refreshCardRefsForFile(file);
        }));

        // 一般滑鼠/觸控板點按拖曳會可靠觸發原生 dragstart（見 handleEditorDragStart 的 arm 邏輯），
        // 一旦原生拖放流程啟動，瀏覽器會改用 drag/dragover/drop 系列事件，不會再送出一般的
        // mousemove/mouseup，所以收尾要靠 document 層級的 drop 事件，而不是原本給三指拖曳用的
        // buttons/mousemove 機制（那一套完全收不到這種原生拖放期間的事件）
        this.registerDomEvent(document, 'dragover', (evt: DragEvent) => {
            if (this.dragGesture) evt.preventDefault();
        });
        // capture 階段註冊：這樣才能在事件傳到 Obsidian Canvas 自己的 drop 監聽器之前先攔下來，
        // 用 stopPropagation() 真正擋掉它，不只是標記 preventDefault（不確定 Obsidian 內部的
        // 原生拖放建卡邏輯有沒有檢查 defaultPrevented，capture + stopPropagation 是更保險的做法，
        // 讓事件根本傳不到它的監聽器）——避免我們自己建立新卡片的同時，原生功能又搶著多建一張
        this.registerDomEvent(document, 'drop', (evt: DragEvent) => {
            const gesture = this.dragGesture;
            if (!gesture) return;
            this.dragGesture = null;
            this.setDragCursorState('none');
            this.lastGestureEndTime = Date.now();
            const target = evt.target as HTMLElement | null;
            if (target?.closest('.canvas-node')) return;
            evt.preventDefault();
            evt.stopPropagation();
            this.completeDragSplit(gesture, evt.clientX, evt.clientY, target);
        }, true);
        this.registerDomEvent(document, 'dragend', () => {
            // 沒有落在合法目標、被瀏覽器判定拖放取消時的保險：清掉殘留狀態，避免卡在 armed 狀態
            if (this.dragGesture) {
                this.dragGesture = null;
                this.setDragCursorState('none');
            }
        });
    }

	// 抽離選單邏輯，確保名稱統一為 Materialize cards to files
    private addMaterializeMenuItem(menu: Menu, canvas: any) {
        menu.addItem((item) => {
            item.setTitle('Materialize cards to files')
                .setIcon('link')
                .onClick(async () => {
                    await this.exportSelectedNodes(canvas);
                });
        });
    }

    async onunload() {
        if (this.patchedCanvasConstructor && this.originalAddNode) {
            this.patchedCanvasConstructor.prototype.addNode = this.originalAddNode;
            console.log("Canvas Card-Materializer: Restored original addNode.");
        }
        // 避免外掛在一次拖曳手勢進行到一半時被停用，殘留全域 mousemove/mouseup 監聽器與待觸發的計時器
        document.removeEventListener('mousemove', this.boundHandleMouseMove);
        document.removeEventListener('mouseup', this.boundHandleMouseUp);
        this.setDragCursorState('none');
        this.cancelHoverArm();
        this.dragGesture = null;
    }

    // 拖曳中的手形游標：不能只設定 document.body 的 cursor 樣式，因為卡片編輯區（CM6）自己有
    // 更明確的 `cursor: text` 規則，優先權比 body 上的樣式高，蓋不過去。改成切換 body 上的
    // class，靠 styles.css 裡的 `!important` + 萬用選擇器強制蓋過卡片內部的游標樣式
    private setDragCursorState(state: 'none' | 'grab' | 'grabbing') {
        document.body.classList.toggle('ccm-dragging', state !== 'none');
        document.body.classList.toggle('ccm-dragging-active', state === 'grabbing');
    }

    // --- 拖曳分割卡片 (Heptabase-style Drag-to-Split) ---

    // 從任一個 DOM 元素反查它屬於哪一個開啟中的 canvas view，藉此拿到未公開的 canvas 實例。
    // 注意：這個方法只適合用在「畫布背景/一般卡片容器」上的元素——實測發現卡片進入編輯模式後，
    // 承載內容的 CM6 `view.dom` 並不是 `workspace-leaf-content` 的子孫節點（可能是另外掛載的浮層/overlay），
    // 用 DOM 包含關係反查會完全找不到。如果手上已經有 CM6 `EditorView`，改用 `findCanvasAndNodeForCmView`。
    public getCanvasFromElement(el: HTMLElement | null): any | null {
        if (!el) return null;
        const leaves = this.app.workspace.getLeavesOfType('canvas');
        for (const leaf of leaves) {
            const view = leaf.view as any;
            if (view?.containerEl?.contains(el)) {
                return view.canvas ?? null;
            }
        }
        return null;
    }

    // 從 CM6 EditorView 反查它屬於哪一個 canvas、對應哪一個 CanvasNode——用 node.child.editor.cm === view
    // 逐一比對每個開啟中 canvas 的 nodes，不依賴 DOM 包含關係（見上方 getCanvasFromElement 的註解）
    public findCanvasAndNodeForCmView(view: EditorView): { canvas: any; node: CanvasNode } | null {
        const leaves = this.app.workspace.getLeavesOfType('canvas');
        for (const leaf of leaves) {
            const canvas = (leaf.view as any)?.canvas;
            if (!canvas || typeof canvas.nodes?.values !== 'function') continue;
            for (const node of canvas.nodes.values()) {
                if ((node as CanvasNode).child?.editor?.cm === view) {
                    return { canvas, node: node as CanvasNode };
                }
            }
        }
        return null;
    }

    // 拖曳分割卡片的觸發邏輯掛在全域的 mousemove 上，對 Obsidian 裡所有編輯器都會觸發——
    // 用這個快取版本讓「不是 canvas 卡片」的一般筆記編輯器，之後每次 mousemove 只需要查一次
    // WeakMap（而不是每次都重跑一遍 findCanvasAndNodeForCmView 逐一比對所有 canvas nodes）
    private isCanvasCardView(view: EditorView): boolean {
        const cached = this.isCanvasCardViewCache.get(view);
        if (cached !== undefined) return cached;
        const result = this.findCanvasAndNodeForCmView(view) !== null;
        this.isCanvasCardViewCache.set(view, result);
        return result;
    }

    // 註冊到 CM6 自己的事件處理管線（EditorView.domEventHandlers），而不是掛在 document 上——
    // 實測發現卡片進入編輯模式後，CM6 會在自己的 DOM 節點上處理 mousedown 且不冒泡出去，
    // 外部的 document 監聽器（不管 capture 或 bubble 階段）完全攔不到。
    // 刻意不攔截 mousedown：一般滑鼠/觸控板點按拖曳維持 CM6 原生行為完全不受影響（使用者要求）。
    //
    // 實測發現一個更根本的問題：按下已選取的文字開始拖曳時，瀏覽器會自動啟動一套獨立的原生
    // HTML5 拖放流程（不需要我們攔截 mousedown 才會啟動），而只要這套原生流程一啟動，
    // 瀏覽器就會停止繼續送出一般的 mousemove/mouseup 事件（改成走 drag/dragover/drop 系列事件），
    // 導致我們原本純靠 mousemove + buttons 判斷「是否在拖曳」的機制完全收不到事件、永遠停在
    // dragging=false——同時 Obsidian Canvas 自己原生就有「拖放文字到空白處會自動建立新卡片」的
    // 功能，會在我們的邏輯完全沒生效的情況下，自己建立一張新卡片，造成「新卡片出現了，但原文字
    // 沒有換成參照」的假象。
    //
    // 因此改成雙軌並存：
    // 1. dragstart：一般滑鼠/觸控板點按拖曳都會可靠觸發這個事件，直接在這裡 arm，
    //    後續交給 document 層級的 drop 監聽收尾（見 onload）
    // 2. mousemove + 停留/按著：三指拖曳這種按下已選取文字時完全不會觸發 dragstart 的情況，
    //    繼續靠這一套機制追蹤（見 handleEditorHoverMove），不需要真的收到 dragstart/mousedown
    private buildDragHandlerExtension() {
        const plugin = this;
        return EditorView.domEventHandlers({
            dragstart: (event: DragEvent, view: EditorView) => plugin.handleEditorDragStart(event, view),
            mousemove: (event: MouseEvent, view: EditorView) => plugin.handleEditorHoverMove(event, view),
            mouseleave: () => plugin.cancelHoverArm(),
            // 放開滑鼠時如果游標還在卡片自己的 DOM 範圍內（還沒被拖到畫布空白處），
            // 用同一套 handleCardMouseUp 收尾（比照「放開在另一張卡片上＝取消」的規則）。
            // 這裡是必要的保險：游標還停留在卡片自己的 DOM 範圍內時，不能保證 mouseup
            // 一定會冒泡到 document，沒有這一段，手勢會卡在「已 arm 但沒被清乾淨」的狀態
            mouseup: (event: MouseEvent, view: EditorView) => {
                if (plugin.dragGesture) {
                    plugin.handleCardMouseUp(event);
                    return true;
                }
                // 沒有進行中的拖曳手勢：放開的當下如果有非空選取，代表這段選取（不管是剛選好的
                // 新選取，還是使用者單純點一下取消選取）現在是「靜止」的，記錄起來，
                // 之後才允許被重新按著這段選取的手勢觸發抓取
                plugin.markSelectionSettled(view);
            }
        });
    }

    // 記錄某個卡片編輯器目前的選取範圍為「已經靜止、沒有正在被拖曳形成」的狀態
    private markSelectionSettled(view: EditorView) {
        const sel = view.state.selection.main;
        if (sel.empty) {
            this.settledSelections.delete(view);
            return;
        }

        const from = Math.min(sel.from, sel.to);
        const to = Math.max(sel.from, sel.to);

        // 選取範圍跟已經記錄的完全一樣就不用重算——這個函式在使用者移動滑鼠時可能被高頻率呼叫，
        // 選取範圍實際上沒有變動的話，沒必要每次都重新切一次字串出來
        const existing = this.settledSelections.get(view);
        if (existing && existing.from === from && existing.to === to) return;

        this.settledSelections.set(view, { from, to, text: view.state.doc.sliceString(from, to) });
    }

    // 找到「目前游標所在位置」是否落在這個 view 目前的選取範圍內；不在範圍內或沒有選取都回傳 null
    private getSelectionOffsetUnderCoords(view: EditorView, x: number, y: number): { selFrom: number; selTo: number } | null {
        const sel = view.state.selection.main;
        if (sel.empty) return null;

        const offset = view.posAtCoords({ x, y });
        if (offset === null || offset === undefined) return null;

        const selFrom = Math.min(sel.from, sel.to);
        const selTo = Math.max(sel.from, sel.to);
        if (offset < selFrom || offset > selTo) return null;

        return { selFrom, selTo };
    }

    // 一般滑鼠/觸控板點按拖曳都會可靠觸發這個事件——dragstart 本身就是瀏覽器對「按下已選取文字
    // 並開始移動」這個手勢天生的判斷，不需要像 hover 停留那樣額外驗證「是否已經靜止」
    // （框選新文字的過程本來就不會觸發 dragstart，這是瀏覽器內建的區分，不用我們自己重新判斷一次）。
    // 不呼叫 preventDefault：放行給瀏覽器繼續原生拖放流程，讓游標視覺回饋等原生行為維持正常，
    // 後續交給 document 層級的 drop 監聽（見 onload）收尾
    private handleEditorDragStart(event: DragEvent, view: EditorView) {
        try {
            if (this.dragGesture) return;
            if (!this.isCanvasCardView(view)) return;

            const hit = this.getSelectionOffsetUnderCoords(view, event.clientX, event.clientY);
            if (!hit) return;

            const gesture = this.buildGestureFromSelection(view, hit, event.clientX, event.clientY, true);
            if (!gesture) return;

            this.cancelHoverArm();
            this.dragGesture = gesture;
            this.setDragCursorState('grabbing');
        } catch (e) {
            console.error('Canvas Card-Materializer: editor dragstart handling failed', e);
            this.dragGesture = null;
        }
    }

    // dragstart（一般拖曳，立即 dragging: true）跟 hover 停留 arm（三指拖曳，dragging: false，
    // 要等移動超過閾值才算真的在拖）共用同一套「從目前選取範圍組出一個 DragGestureState」的邏輯，
    // 差別只在 dragging 初始值——抽出來避免兩處各維護一份幾乎一樣的查找/組裝程式碼
    private buildGestureFromSelection(
        view: EditorView,
        hit: { selFrom: number; selTo: number },
        x: number,
        y: number,
        dragging: boolean
    ): DragGestureState | null {
        const found = this.findCanvasAndNodeForCmView(view);
        if (!found) return null;
        const { canvas, node } = found;
        const editor = node?.child?.editor;
        if (!editor) return null;

        const text = view.state.doc.sliceString(hit.selFrom, hit.selTo);
        if (!text.trim()) return null;

        return {
            canvas,
            sourceNode: node,
            editor,
            from: editor.offsetToPos(hit.selFrom),
            to: editor.offsetToPos(hit.selTo),
            text,
            startX: x,
            startY: y,
            dragging
        };
    }

    // 游標移到選取範圍上、停留 HOVER_ARM_DELAY_MS 之後也視為拖曳起手式——不需要真的按下按鍵，
    // 用來涵蓋三指拖曳「按住已選取文字」時可能完全不會送出 mousedown 的情況
    private handleEditorHoverMove(event: MouseEvent, view: EditorView) {
        try {
            // 已經 arm 過（不管是透過 mousedown 還是停留），這裡額外用 CM6 自己的 mousemove
            // 判斷是否超過拖曳閾值——不能只依賴 document 層級的 mousemove，因為游標還停留在
            // 卡片自己的 DOM 範圍內時，那些事件不保證可靠地冒泡到 document（跟一開始
            // mousedown 攔不到是同一個底層限制）。一旦游標離開卡片範圍，document 層級的
            // mousemove/mouseup 才會接手後續追蹤（見 handleCardMouseMove/handleCardMouseUp）
            if (this.dragGesture) {
                // 三指拖曳的「放開」不一定會送出獨立的 mouseup 事件——只要這裡的 mousemove
                // 帶著 buttons === 0，就當作已經放開，直接收尾（見 handleCardMouseMove 的同一個處理）
                if (event.buttons === 0) {
                    this.handleCardMouseUp(event);
                    return;
                }
                this.checkDragThreshold(event.clientX, event.clientY);
                return;
            }

            // 這個 handler 對 Obsidian 裡所有編輯器都會觸發，不只是 canvas 卡片——不是 canvas 卡片
            // 就直接跳過，避免對一般筆記編輯器做任何多餘的判斷（尤其是下面 markSelectionSettled
            // 的字串切割，不然只要那個編輯器裡有選取文字、使用者又剛好在移動滑鼠，就會被白白觸發）
            if (!this.isCanvasCardView(view)) return;

            // 只有「看起來像是按著」的狀態（真的按著滑鼠鍵，或三指拖曳合成出來的按住訊號）才要考慮
            // 觸發——純粹經過、沒有按著的游標移動不該有任何視覺回饋或計時。`event.buttons === 1`
            // 涵蓋這兩種情況：不管是不是真的收到過 mousedown，只要當下這個 mousemove 帶著
            // 「主按鍵按著」的狀態就算數
            if (event.buttons !== 1) {
                // 沒有按著：把目前的選取範圍記錄成「已經靜止」，供之後重新按著時比對
                this.markSelectionSettled(view);
                this.cancelHoverArm();
                return;
            }

            // 上一個手勢才剛結束不久，忽略這段冷卻期內的按著移動——避免三指拖曳放開後的
            // 殘留移動事件被誤判成使用者要立刻抓取另一段文字
            if (Date.now() - this.lastGestureEndTime < GESTURE_COOLDOWN_MS) {
                this.cancelHoverArm();
                return;
            }

            // 按著移動中：只有目前的選取範圍剛好等於「這次按下之前就已經穩定存在」的選取範圍，
            // 才視為「重新抓取一段既有選取」的候選手勢；如果選取範圍還在變動（代表使用者正在
            // 拖曳框選一段新文字，例如三指拖曳框選時），一律忽略，不能觸發拖曳分割
            const sel = view.state.selection.main;
            const settled = this.settledSelections.get(view);
            const curFrom = Math.min(sel.from, sel.to);
            const curTo = Math.max(sel.from, sel.to);
            if (
                sel.empty ||
                !settled ||
                settled.from !== curFrom ||
                settled.to !== curTo ||
                // 只比對 offset 不夠：拖曳分割完成後，原文字被换成 ((card:id)) chip，
                // 如果剛好落在同一段 offset 範圍內，沒有這個文字比對會被誤判成「還是同一段既有選取」
                settled.text !== view.state.doc.sliceString(curFrom, curTo)
            ) {
                this.cancelHoverArm();
                return;
            }

            const hit = this.getSelectionOffsetUnderCoords(view, event.clientX, event.clientY);
            if (!hit) {
                this.cancelHoverArm();
                return;
            }

            // 一進入選取範圍就先給視覺回饋（手掌抓握圖案），不用等停留計時器跑完，
            // 讓使用者知道「已經進入可以拖曳的區域」，即使最後沒有真的拖曳也沒有副作用
            this.setDragCursorState('grab');

            // 已經在倒數計時中，游標還在選取範圍內就不用重新計時
            if (this.hoverArmTimer !== null) return;

            const armX = event.clientX;
            const armY = event.clientY;
            this.hoverArmTimer = window.setTimeout(() => {
                this.hoverArmTimer = null;
                this.armDragGestureFromHover(view, armX, armY);
            }, HOVER_ARM_DELAY_MS);
        } catch (e) {
            console.error('Canvas Card-Materializer: hover arm handling failed', e);
            this.cancelHoverArm();
        }
    }

    private cancelHoverArm() {
        if (this.hoverArmTimer !== null) {
            window.clearTimeout(this.hoverArmTimer);
            this.hoverArmTimer = null;
        }
        // 手勢還沒真的 arm 就取消（例如游標離開了選取範圍），把提前顯示的手掌游標也還原掉；
        // 已經 arm 的話（this.dragGesture 存在）游標狀態由呼叫端自己管理，這裡不要動它
        if (!this.dragGesture) {
            this.setDragCursorState('none');
        }
    }

    private armDragGestureFromHover(view: EditorView, x: number, y: number) {
        try {
            if (this.dragGesture) return;

            // 停留期間選取範圍可能已經變了（使用者改變主意重新選字），用當下最新的選取範圍為準
            const hit = this.getSelectionOffsetUnderCoords(view, x, y);
            if (!hit) return;

            const gesture = this.buildGestureFromSelection(view, hit, x, y, false);
            if (!gesture) return;

            this.dragGesture = gesture;
            this.setDragCursorState('grab');
            document.addEventListener('mousemove', this.boundHandleMouseMove);
            document.addEventListener('mouseup', this.boundHandleMouseUp);
        } catch (e) {
            console.error('Canvas Card-Materializer: hover arm drag gesture failed', e);
            this.dragGesture = null;
        }
    }

    private handleCardMouseMove(evt: MouseEvent) {
        if (!this.dragGesture) return;

        // 三指拖曳的「放開」不一定會送出獨立的 mouseup 事件——與其一直等一個可能永遠不會來的訊號，
        // 改成只要移動事件裡的 buttons 變回 0（代表已經沒有按著/沒有手指了），就當作放開處理，
        // 直接拿這個座標當作放開位置收尾
        if (evt.buttons === 0) {
            this.handleCardMouseUp(evt);
            return;
        }

        this.checkDragThreshold(evt.clientX, evt.clientY);
    }

    // CM6 層級（卡片還在自己 DOM 範圍內）跟 document 層級（游標已經移出卡片、在畫布背景上）
    // 都需要判斷同一件事：目前是否已經移動超過 4px 閾值，超過就正式標記為「真的在拖」並換成
    // 抓握游標——兩處共用這個函式，避免同一段判斷邏輯維護兩份
    private checkDragThreshold(x: number, y: number) {
        const gesture = this.dragGesture;
        if (!gesture || gesture.dragging) return;
        const dx = x - gesture.startX;
        const dy = y - gesture.startY;
        // 4px 的移動閾值，避免手抖/單純點擊被誤判成拖曳
        if (Math.hypot(dx, dy) > 4) {
            gesture.dragging = true;
            this.setDragCursorState('grabbing');
        }
    }

    // 只有拖到「空白畫布」才會建立新卡片；拖到另一張既有卡片上一律視為取消，不做合併行為；
    // 如果整段手勢從頭到尾都沒有真的移動超過閾值，就當作使用者只是單純點一下
    private handleCardMouseUp(evt: MouseEvent) {
        document.removeEventListener('mousemove', this.boundHandleMouseMove);
        document.removeEventListener('mouseup', this.boundHandleMouseUp);
        this.setDragCursorState('none');
        this.cancelHoverArm();

        const gesture = this.dragGesture;
        this.dragGesture = null;
        if (!gesture) return;

        // 手勢真正結束（不管有沒有真的建立新卡片），記錄時間戳開始一段冷卻期，
        // 擋掉三指拖曳放開後可能還會殘留幾個 buttons=1 移動事件造成的誤觸
        this.lastGestureEndTime = Date.now();

        if (!gesture.dragging) {
            // 這個手勢完全沒攔截過任何按鍵事件（不再攔截 mousedown），CM6/瀏覽器自己的預設行為
            // 從頭到尾都正常運作，不需要、也不該由我們插手還原游標位置
            return;
        }

        const target = evt.target as HTMLElement | null;
        if (target?.closest('.canvas-node')) return;
        this.completeDragSplit(gesture, evt.clientX, evt.clientY, target);
    }

    // 拖放完成的收尾——不管是透過瀏覽器原生 HTML5 拖放（一般滑鼠/觸控板點按拖曳，見
    // buildDragHandlerExtension 的 drop 監聽）、還是靠 buttons/hover 自己追蹤出來的拖曳
    // （三指拖曳，dragstart 不會觸發的情況），最後都走這同一個收尾函式。
    //
    // 曾經嘗試改成「借用 Obsidian 原生拖放建卡功能，不自己建卡」（監看 canvas:node:added、
    // 比對文字內容），但實測發現比對常常抓不到原生建立的那張卡（推測原生建卡時 node.text 的
    // 實際內容跟我們拿到的選取文字不會逐字完全相同——可能有多餘的空白、換行、或原生流程本身做了
    // 其他轉換），逾時安全網一啟動就會多建一張，反而變成兩張重複卡片，原文字也因為一直沒等到
    // 逾時觸發的那一次收尾而沒被換成 chip。已放棄這個方向，改回**自己直接建立新卡片**（穩定、
    // 可預期），並且用 capture 階段 + `stopPropagation()` 積極阻止 Obsidian 原生的拖放建卡邏輯
    // 收到同一個 drop 事件（見 onload 的 drop 監聽），從源頭避免原生功能又搶著多建一張
    private completeDragSplit(gesture: DragGestureState, dropX: number, dropY: number, dropTarget: EventTarget | null) {
        try {
            const canvas = this.getCanvasFromElement(dropTarget as HTMLElement | null);
            if (!canvas || canvas !== gesture.canvas) return;

            if (typeof canvas.createTextNode !== 'function') {
                new Notice('此 Obsidian 版本不支援拖曳分割卡片（找不到內部建立卡片的方法）。');
                return;
            }

            const pos = typeof canvas.posFromEvt === 'function'
                ? canvas.posFromEvt({ clientX: dropX, clientY: dropY })
                : { x: gesture.sourceNode.x ?? 0, y: gesture.sourceNode.y ?? 0 };

            const newNode = canvas.createTextNode({
                pos,
                size: { width: 250, height: 120 },
                text: gesture.text,
                save: true,
                focus: false
            });

            const newId: string | undefined = newNode?.id;
            if (!newId) {
                new Notice('分割卡片失敗：無法取得新卡片 id。');
                return;
            }

            // 原本被選取的文字换成只存 id 的參照 token，顯示用的標題由 CM6 widget 在渲染當下即時查詢目標卡片
            gesture.editor.replaceRange(`((card:${newId}))`, gesture.from, gesture.to);
            canvas.requestSave();

            // 保險：主動清掉這個編輯器殘留的舊「已穩定選取」紀錄，避免內容比對還沒生效前的空窗期
            // 被舊紀錄誤判成「還是同一段既有選取」而重複觸發
            const cm: EditorView | undefined = (gesture.editor as any).cm;
            if (cm) this.settledSelections.delete(cm);
        } catch (e) {
            console.error('Canvas Card-Materializer: split card failed', e);
            new Notice('分割卡片失敗，詳情請查看開發者主控台。');
        }
    }

    // 某個已 materialize 成檔案的卡片被改名或改內容時，主動找出畫面上所有指向它的 chip
    // （用 data-card-ref-id 比對），就地重新渲染，不用等使用者剛好點進來源卡片編輯模式才更新
    private refreshCardRefsForFile(file: TFile) {
        try {
            const canvasId = this.app.metadataCache.getFileCache(file)?.frontmatter?.['canvas_id'];
            if (canvasId === undefined || canvasId === null) return;
            const idStr = String(canvasId);
            const elements = document.querySelectorAll(`.ccm-card-ref[data-card-ref-id="${CSS.escape(idStr)}"]`);
            elements.forEach((el) => {
                const canvas = this.getCanvasFromElement(el as HTMLElement);
                const fresh = renderCardRefChip(this, canvas, idStr);
                el.replaceWith(fresh);
            });
        } catch (e) {
            console.error('Canvas Card-Materializer: refresh card ref for file failed', e);
        }
    }

    // 掃描一段已經渲染好的 markdown HTML，把裡面所有 ((card:id)) 純文字換成 renderCardRefChip
    // 產生的 chip 元素——用來補足卡片在「未聚焦/唯讀」狀態下不會經過 CM6 ViewPlugin 的缺口。
    // registerMarkdownPostProcessor 執行的當下，el 不一定已經真的掛進 DOM，這時 getCanvasFromElement
    // （依賴 DOM 包含關係）會反查不到 canvas；用短暫重試等它掛上去，重試完還是找不到，
    // 退回「目前只開一張 canvas 就直接用它」的權宜猜測，兩者都失敗才真的顯示成失效樣式
    private processCardRefsInElement(root: HTMLElement, attempt = 0) {
        let canvas = this.getCanvasFromElement(root);
        if (!canvas && attempt < 6) {
            window.setTimeout(() => this.processCardRefsInElement(root, attempt + 1), 60 * (attempt + 1));
            return;
        }
        if (!canvas) {
            const leaves = this.app.workspace.getLeavesOfType('canvas');
            if (leaves.length === 1) canvas = (leaves[0].view as any)?.canvas ?? null;
        }
        this.replaceCardRefTextNodes(root, canvas);
    }

    private replaceCardRefTextNodes(root: HTMLElement, canvas: any) {
        try {
            const textNodes: Text[] = [];
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let n: Node | null;
            while ((n = walker.nextNode())) {
                if (n.textContent && n.textContent.includes('((card:')) {
                    textNodes.push(n as Text);
                }
            }

            for (const textNode of textNodes) {
                const text = textNode.textContent ?? '';
                CARD_REF_REGEX.lastIndex = 0;
                let match: RegExpExecArray | null;
                let lastIndex = 0;
                let matched = false;
                const frag = document.createDocumentFragment();

                while ((match = CARD_REF_REGEX.exec(text))) {
                    matched = true;
                    if (match.index > lastIndex) {
                        frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
                    }
                    frag.appendChild(renderCardRefChip(this, canvas, match[1]));
                    lastIndex = match.index + match[0].length;
                }

                if (!matched) continue;
                if (lastIndex < text.length) {
                    frag.appendChild(document.createTextNode(text.slice(lastIndex)));
                }
                textNode.parentNode?.replaceChild(frag, textNode);
            }
        } catch (e) {
            console.error('Canvas Card-Materializer: card ref post-process failed', e);
        }
    }

    // FR-1 提到的 select + zoom 導航手法，這裡沿用同一套技術風險（selectOnly/zoomToSelection 命名未公開）
    public jumpToCardRef(canvas: any, id: string) {
        try {
            const node = canvas?.nodes?.get?.(id);
            if (!node) {
                new Notice('找不到對應的卡片，可能已被刪除。');
                return;
            }
            if (typeof canvas.selectOnly === 'function') {
                canvas.selectOnly(node);
            }
            if (typeof canvas.zoomToSelection === 'function') {
                canvas.zoomToSelection();
            }
        } catch (e) {
            console.error('Canvas Card-Materializer: jump to card failed', e);
        }
    }

    // 广播「某張卡片文字變了」給所有目前開著的卡片編輯器，讓它們重新查一次自己畫面上 ((card:id)) chip 的標題
    private broadcastCardRefRefresh(exclude: EditorView) {
        for (const view of this.activeCardRefEditors) {
            if (view === exclude) continue;
            try {
                view.dispatch({ effects: refreshCardRefs.of() });
            } catch (e) {
                // view 可能已經被銷毀，忽略即可
            }
        }
    }

    // 註冊到每一個 canvas text node 編輯器（實際上是一般的 CM6 Live Preview 擴充）：
    // 掃描文字比對 ((card:id))，換成一個即時渲染目標卡片標題的 chip
    private buildCardRefViewPlugin() {
        const plugin = this;
        return ViewPlugin.fromClass(class {
            decorations: DecorationSet;
            constructor(public view: EditorView) {
                this.decorations = buildCardRefDecorations(view, plugin);
                plugin.activeCardRefEditors.add(view);
            }
            update(update: ViewUpdate) {
                const wasToldToRefresh = update.transactions.some((tr) =>
                    tr.effects.some((e) => e.is(refreshCardRefs))
                );
                if (update.docChanged || update.viewportChanged || wasToldToRefresh) {
                    this.decorations = buildCardRefDecorations(update.view, plugin);
                }
                if (update.docChanged) {
                    plugin.broadcastCardRefRefresh(update.view);
                }
            }
            destroy() {
                plugin.activeCardRefEditors.delete(this.view);
            }
        }, {
            decorations: (v: any) => v.decorations
        });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private patchCanvasConstructor() {
        if (this.patchedCanvas) return;
        const leaves = this.app.workspace.getLeavesOfType('canvas');
        if (leaves.length === 0) {
            const eventRef = this.app.workspace.on('layout-change', () => {
                const newLeaves = this.app.workspace.getLeavesOfType('canvas');
                if (newLeaves.length > 0) {
                    this.app.workspace.offref(eventRef);
                    this.patchCanvasConstructor();
                }
            });
            return;
        }

        const canvasView = leaves[0].view as any;
        const canvasInstance = canvasView.canvas;
        if (canvasInstance && canvasInstance.constructor) {
            this.patchedCanvasConstructor = canvasInstance.constructor;
            this.originalAddNode = canvasInstance.constructor.prototype.addNode;
            const pluginApp = this.app;
            const originalFn = this.originalAddNode;

            canvasInstance.constructor.prototype.addNode = function (node: any) {
                const result = originalFn!.apply(this, arguments);
                pluginApp.workspace.trigger('canvas:node:added', this, node);
                return result;
            };
            this.patchedCanvas = true;
            console.log("Canvas Card-Materializer: Successfully patched.");
        }
    }

    async exportSelectedNodes(canvas: any) {
        const canvasFile = canvas.view?.file;
        if (!(canvasFile instanceof TFile)) return;

        if (this.processingCanvases.has(canvasFile.path)) {
            new Notice("此 canvas 正在轉換中，請稍候再試一次。");
            return;
        }
        this.processingCanvases.add(canvasFile.path);

        try {

        const canvasDir = canvasFile.parent ? canvasFile.parent.path : "";
        const canvasName = canvasFile.basename;
        const baseFolderPath = canvasDir === "" ? canvasName : `${canvasDir}/${canvasName}`;

        const rawSelection: Set<any> = canvas.selection;
        const selectedNodes: CanvasNode[] = Array.from(rawSelection).filter(
            // 排除 edge（有 .from）跟 group（未公開型別，比照既有的 unknownData.type 判斷慣例排除，
            // 避免框選整個 group 時被誤判成一張待轉換的文字卡而生出多餘的 Untitled.md）
            (item) => item.x !== undefined && item.y !== undefined && !item.from && (item as any).unknownData?.type !== 'group'
        );

        if (selectedNodes.length === 0) {
            new Notice("No valid cards selected.");
            return;
        }

        const exportMap = new Map<string, { filename: string; text: string; color: string; fileObj: TFile }>();
        const timestamp = moment().format('YYYYMMDDHHmm');
        const usedNames = new Set<string>();
        const failedPaths: string[] = [];
        let newlyCreatedCount = 0;

        // Pass 1: 建立基礎檔案
        for (const node of selectedNodes) {

			if (node.file instanceof TFile || (node as any).unknownData?.type === 'file') {
                const existingFile = node.file instanceof TFile ? node.file : 
                                   (this.app.vault.getAbstractFileByPath((node as any).file) as TFile);
                
                if (existingFile) {
                    exportMap.set(node.id, {
                        filename: existingFile.basename,
                        text: "", // 已經有檔案了，不需要紀錄文字內容
                        color: node.color ? String(node.color) : "0",
                        fileObj: existingFile
                    });
                    continue; // 跳過下方的產檔逻辑，直接處理下一個節點
                }
            }
			
            let fullText = node.text || (node.file ? node.file.basename : 'Untitled');
            const lines = fullText.split('\n');
            const firstLine = lines[0].trim(); 
            
            let shortName = this.sanitizeFileName(firstLine);
            if (shortName.length > 50) shortName = shortName.substring(0, 50).trim();
            
            // 不再依顏色分子資料夾——顏色本來就已經寫進 canvas_color frontmatter（見下方 Pass 3），
            // 用資料夾再分一次等於維護兩份顏色紀錄，而且卡片改色後資料夾不會跟著動，兩邊會愈來愈不一致
            const nodeColor = node.color ? String(node.color) : "0";
            const finalFolderPath = baseFolderPath;

            await this.ensureFolderExists(finalFolderPath);

            // 檔名去重：除了本批次內的 usedNames，也要檢查 vault 裡是否已經有同名檔案存在於這個路徑，
            // 避免撞到跟這個 plugin 完全無關的既有筆記時被 vault.modify() 靜默覆寫內容（BUG-1）
            let filename = shortName;
            let fullPath = `${finalFolderPath}/${filename}.md`;
            let counter = 1;
            while (usedNames.has(filename) || this.app.vault.getAbstractFileByPath(fullPath)) {
                filename = `${shortName}_${timestamp}_${counter++}`;
                fullPath = `${finalFolderPath}/${filename}.md`;
            }
            usedNames.add(filename);

            let textContent = node.file ? `![[${node.file.path}]]` :
                             (lines.length > 1 ? lines.slice(1).join('\n').trim() : fullText);

            try {
                const targetFile = await this.app.vault.create(fullPath, textContent);
                newlyCreatedCount++;

                exportMap.set(node.id, {
                    filename,
                    text: textContent,
                    color: nodeColor,
                    fileObj: targetFile
                });
            } catch (e) {
                console.error(`Materializer Error: ${fullPath}`, e);
                failedPaths.push(fullPath);
            }
        }

        // Pass 2: 處理連線與雙向連結
        const edges: Set<CanvasEdge> = canvas.edges;
        // 分別記錄「指出去」跟「被指向」兩個方向——實測證實 frontmatter 屬性裡的 [[wikilink]]
        // 不會被 Obsidian 原生 Backlinks 索引（只有正文提及才會），所以兩個方向都要自己算、自己存，
        // 不能只算 outgoing 再假設對方的 incoming 可以靠原生 Backlinks 免費取得
        const outUpdates = new Map<string, string[]>();
        const inUpdates = new Map<string, string[]>();

        if (edges) {
            edges.forEach((edge) => {
                const fromId = edge.from?.node?.id;
                const toId = edge.to?.node?.id;
                if (fromId && toId && exportMap.has(fromId) && exportMap.has(toId)) {
                    const sourceData = exportMap.get(fromId)!;
                    const targetData = exportMap.get(toId)!;

                    const outLinkPath = this.app.metadataCache.fileToLinktext(targetData.fileObj, sourceData.fileObj.path);
                    if (!outUpdates.has(fromId)) outUpdates.set(fromId, []);
                    outUpdates.get(fromId)!.push(`[[${outLinkPath}]]`);

                    const inLinkPath = this.app.metadataCache.fileToLinktext(sourceData.fileObj, targetData.fileObj.path);
                    if (!inUpdates.has(toId)) inUpdates.set(toId, []);
                    inUpdates.get(toId)!.push(`[[${inLinkPath}]]`);
                }
            });
        }

        // Pass 3: 寫入 YAML frontmatter，包含連結資訊（個別 try/catch，單一檔案失敗不能中斷整批，見 BUG-3）
        // canvas_out：這張卡片指出去的箭頭；canvas_in：指向這張卡片的箭頭。兩者都跟既有值合併去重，
        // 不會覆蓋掉之前批次寫入、這次批次沒有重新算到的項目
        for (const [id, data] of exportMap.entries()) {
            const file = data.fileObj;
            try {
                const outLinks = outUpdates.get(id);
                const inLinks = inUpdates.get(id);
                await this.app.fileManager.processFrontMatter(file, (fm) => {
                    fm['canvas_id'] = id;
                    if (data.color) fm['canvas_color'] = data.color;

                    // 用顏色同步一個 `canvas-color/<顏色名>` tag，讓 Obsidian 原生的 tag 面板/搜尋
                    // 就能像 Heptabase 用顏色分類卡片那樣，把同色的筆記聚合起來看
                    const existingTags: string[] = Array.isArray(fm['tags'])
                        ? fm['tags']
                        : (typeof fm['tags'] === 'string' && fm['tags'] ? [fm['tags']] : []);
                    const withoutColorTags = existingTags.filter((t) => !t.startsWith('canvas-color/'));
                    const colorTagName = data.color ? this.colorToTagName(data.color) : null;
                    const nextTags = colorTagName
                        ? Array.from(new Set([...withoutColorTags, `canvas-color/${colorTagName}`]))
                        : withoutColorTags;
                    if (nextTags.length > 0 || existingTags.length > 0) fm['tags'] = nextTags;

                    if (outLinks && outLinks.length > 0) {
                        const existing: string[] = Array.isArray(fm['canvas_out']) ? fm['canvas_out'] : [];
                        fm['canvas_out'] = Array.from(new Set([...existing, ...outLinks]));
                    }
                    if (inLinks && inLinks.length > 0) {
                        const existing: string[] = Array.isArray(fm['canvas_in']) ? fm['canvas_in'] : [];
                        fm['canvas_in'] = Array.from(new Set([...existing, ...inLinks]));
                    }
                });
            } catch (e) {
                console.error(`Materializer Error (frontmatter): ${file.path}`, e);
                failedPaths.push(file.path);
            }
        }

        // --- Pass 4: 連線與群組保護的強制更新 ---
        const currentCanvas = canvas;
        const allData = currentCanvas.getData(); 
        const exportNodeIds = new Set(exportMap.keys());

        const updatedNodes = allData.nodes.map((n: any) => {
            // 【重要】絕對不要動 type 為 group 的節點資料
            if (n.type === 'group') return n;

            if (exportNodeIds.has(n.id)) {
                if (n.type === 'file') return n;
                const targetData = exportMap.get(n.id)!;
                return { 
                    ...n, 
                    type: 'file', 
                    file: targetData.fileObj.path,
                    text: undefined 
                };
            }
            return n;
        });

        currentCanvas.deselectAll();

        // 1. 【核心策略】：只清空 Nodes，但絕對要保留 edges 和 groups 的「原始引用」
        currentCanvas.setData({ 
            nodes: [], 
            edges: allData.edges || [], 
            groups: allData.groups || [] // 確保清空時群組還在畫布上「等著」
        });

        // 2. 稍微縮短一點延遲，減少視覺上的閃爍 (100ms 通常就夠了)
        // 改用 await 而非單純的 setTimeout fire-and-forget，讓這個函式真正的完成時機涵蓋兩段式 setData 全程，
        // 這樣下面 finally 釋放 processingCanvases 鎖時，畫布才真的已經更新完畢（見 BUG-4）
        await new Promise<void>((resolve) => setTimeout(resolve, 100));

        // 3. 回填更新後的節點，並確保順序跟原本一模一樣
        // (這能解決圖層跑掉的問題，因為節點順序決定了渲染層級)
        currentCanvas.setData({
            nodes: updatedNodes,
            edges: allData.edges || [],
            groups: allData.groups || []
        });

        currentCanvas.requestSave();

        // 4. 強制通知 Canvas 更新佈局 (Layout)
        if (typeof currentCanvas.requestFrame === 'function') {
            currentCanvas.requestFrame();
        }

        if (failedPaths.length > 0) {
            new Notice(`已轉換 ${newlyCreatedCount} 張卡片，但其中 ${failedPaths.length} 個檔案處理時發生錯誤，詳情請查看開發者主控台。`);
        } else if (newlyCreatedCount === 0) {
            // 所有選取的卡片本來就已經是 file node，這次沒有建立任何新檔案，
            // 跟「成功轉換」是不同的結果，訊息要分開講，避免使用者誤以為又轉了一次
            new Notice(`所選卡片皆已 materialize，未建立新檔案。`);
        } else {
            new Notice(`Successfully materialized ${newlyCreatedCount} nodes!`);
        }
        } finally {
            this.processingCanvases.delete(canvasFile.path);
        }
    }

    async ensureFolderExists(path: string) {
        const folders = path.replace(/\\/g, '/').replace(/^\/|\/$/g, '').split('/');
        let currentPath = '';
        for (const folder of folders) {
            currentPath = currentPath === '' ? folder : `${currentPath}/${folder}`;
            if (!this.app.vault.getAbstractFileByPath(currentPath)) {
                await this.app.vault.createFolder(currentPath);
            }
        }
    }

    sanitizeFileName(name: string): string {
        return name.replace(/^#+\s*/, '').replace(/`/g, '').replace(/[\\/:"*?<>|#^[\]]/g, '').trim() || 'Untitled';
    }

    // 把 canvas_color 轉成人類可讀的 tag 名稱：1-6 是 Obsidian Canvas 內建的六種預設色，
    // 其餘視為自訂 hex 色碼，直接拿掉 # 當 tag 用（"0" 代表卡片沒特別選色，不算一種顏色分類，不產生 tag）
    private static readonly COLOR_TAG_NAMES: Record<string, string> = {
        '1': 'red',
        '2': 'orange',
        '3': 'yellow',
        '4': 'green',
        '5': 'cyan',
        '6': 'purple',
    };

    colorToTagName(color: string): string | null {
        if (!color || color === '0') return null;
        if (CanvasCardMaterializer.COLOR_TAG_NAMES[color]) return CanvasCardMaterializer.COLOR_TAG_NAMES[color];
        return color.startsWith('#') ? color.slice(1).toLowerCase() : color;
    }
}

// --- 拖曳分割卡片：((card:id)) chip 的渲染 ---

function buildCardRefDecorations(view: EditorView, plugin: CanvasCardMaterializer): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        CARD_REF_REGEX.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = CARD_REF_REGEX.exec(text))) {
            const start = from + match.index;
            const end = start + match[0].length;
            builder.add(start, end, Decoration.replace({ widget: new CardRefWidget(plugin, match[1]) }));
        }
    }
    return builder.finish();
}

// 兩種渲染場景共用：CM6 即時編輯狀態的 widget（CardRefWidget）、以及卡片未聚焦/唯讀狀態下
// 走一般 Obsidian markdown 渲染管線的 registerMarkdownPostProcessor（見 CanvasCardMaterializer
// 的 processCardRefsInElement）。canvas 傳 null 時（例如還沒能反查到）會退化成「已失效」樣式，
// 不會噴例外
function renderCardRefChip(plugin: CanvasCardMaterializer, canvas: any, id: string): HTMLElement {
    const span = document.createElement('span');
    span.addClass('ccm-card-ref');
    span.setAttribute('data-card-ref-id', id);

    try {
        const node = canvas?.nodes?.get?.(id);

        if (!node) {
            span.addClass('ccm-card-ref-broken');
            span.setText(`card:${id}`);
        } else {
            // 標題只在渲染當下即時查詢目標卡片目前的文字，不快取，這樣目標卡片改內容後這裡會跟著更新，
            // 而且是走正規 MarkdownRenderer，巢狀的 inline code / inline math / 粗體才會正常渲染
            const rawText = String(node.text ?? node.file?.basename ?? '');
            const title = rawText.split('\n')[0].trim() || '(empty card)';
            const sourcePath = canvas?.view?.file?.path ?? '';
            MarkdownRenderer.render(plugin.app, title, span, sourcePath, plugin)
                .catch(() => span.setText(title));
        }
    } catch (e) {
        span.addClass('ccm-card-ref-broken');
        span.setText(`card:${id}`);
    }

    // 阻止 CM6 把這次點擊當成一般的游標定位/選取，避免點 chip 卻只是把游標插進 token 裡
    span.addEventListener('mousedown', (evt) => evt.preventDefault());
    span.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        if (canvas) plugin.jumpToCardRef(canvas, id);
    });

    return span;
}

class CardRefWidget extends WidgetType {
    constructor(private plugin: CanvasCardMaterializer, private id: string) {
        super();
    }

    toDOM(view: EditorView): HTMLElement {
        const canvas = this.plugin.findCanvasAndNodeForCmView(view)?.canvas;
        return renderCardRefChip(this.plugin, canvas, this.id);
    }

    ignoreEvent(): boolean {
        return false;
    }
}

// --- Settings Tab ---
class CanvasCardMaterializerSettingTab extends PluginSettingTab {
    plugin: CanvasCardMaterializer;
    constructor(app: App, plugin: CanvasCardMaterializer) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        new Setting(containerEl)
            .setName('Default Export Directory')
            .setDesc('Fallback directory for exports.')
            .addText((text) =>
                text.setValue(this.plugin.settings.exportPath)
                    .onChange(async (v) => {
                        this.plugin.settings.exportPath = v;
                        await this.plugin.saveSettings();
                    })
            );
    }
}