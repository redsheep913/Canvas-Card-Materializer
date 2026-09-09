import {
    App,
    Menu,
    Notice,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    moment
} from 'obsidian';

// --- Internal Canvas Interfaces ---
interface CanvasNode {
    id: string;
    text?: string;
    file?: TFile;
    color?: string;
    from?: any; 
    to?: any;   
    unknownData?: { type: string };
    setAttributes?: (attrs: any) => void;
    canvas: any;
}

interface CanvasEdge {
    id: string;
    from: { node: CanvasNode };
    to: { node: CanvasNode };
}

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