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

        const canvasDir = canvasFile.parent ? canvasFile.parent.path : "";
        const canvasName = canvasFile.basename;
        const baseFolderPath = canvasDir === "" ? canvasName : `${canvasDir}/${canvasName}`;

        const colorFolderMap: { [key: string]: string } = {
            "0": "Default", "1": "Red", "2": "Orange", "3": "Yellow", "4": "Blue", "5": "Green", "6": "Purple",
        };

        const rawSelection: Set<any> = canvas.selection;
        const selectedNodes: CanvasNode[] = Array.from(rawSelection).filter(
            (item) => item.x !== undefined && item.y !== undefined && !item.from
        );

        if (selectedNodes.length === 0) {
            new Notice("No valid cards selected.");
            return;
        }

        const exportMap = new Map<string, { filename: string; text: string; color: string; fileObj: TFile }>();
        const timestamp = moment().format('YYYYMMDDHHmm');
        const usedNames = new Set<string>();

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
            
            let filename = shortName;
            let counter = 1;
            while (usedNames.has(filename)) {
                filename = `${shortName}_${timestamp}_${counter++}`;
            }
            usedNames.add(filename);

            const nodeColor = node.color ? String(node.color) : "0"; 
            const subFolder = colorFolderMap[nodeColor] || "Default"; 
            const finalFolderPath = `${baseFolderPath}/${subFolder}`;

            await this.ensureFolderExists(finalFolderPath);
            const fullPath = `${finalFolderPath}/${filename}.md`;
            
            let textContent = node.file ? `![[${node.file.path}]]` : 
                             (lines.length > 1 ? lines.slice(1).join('\n').trim() : fullText);

            try {
                let targetFile = this.app.vault.getAbstractFileByPath(fullPath);
                if (!(targetFile instanceof TFile)) {
                    targetFile = await this.app.vault.create(fullPath, textContent);
                } else {
                    await this.app.vault.modify(targetFile, textContent);
                }

                exportMap.set(node.id, {
                    filename,
                    text: textContent,
                    color: nodeColor,
                    fileObj: targetFile as TFile
                });
            } catch (e) {
                console.error(`Materializer Error: ${fullPath}`, e);
            }
        }

        // Pass 2: 處理連線與雙向連結
        const edges: Set<CanvasEdge> = canvas.edges;
        const linkUpdates = new Map<string, string[]>();

        if (edges) {
            edges.forEach((edge) => {
                const fromId = edge.from?.node?.id;
                const toId = edge.to?.node?.id;
                if (fromId && toId && exportMap.has(fromId) && exportMap.has(toId)) {
                    const sourceData = exportMap.get(fromId)!;
                    const targetData = exportMap.get(toId)!;
                    const linkPath = this.app.metadataCache.fileToLinktext(targetData.fileObj, sourceData.fileObj.path);
                    if (!linkUpdates.has(fromId)) linkUpdates.set(fromId, []);
                    linkUpdates.get(fromId)!.push(`[[${linkPath}]]`);
                }
            });
        }

        // Pass 3: 寫入 YAML 與 附加連結文字
        for (const [id, data] of exportMap.entries()) {
            const file = data.fileObj;
            await this.app.fileManager.processFrontMatter(file, (fm) => {
                fm['canvas_id'] = id;
                if (data.color) fm['canvas_color'] = data.color;
            });

            const links = linkUpdates.get(id);
            if (links && links.length > 0) {
                const content = await this.app.vault.read(file);
                if (!content.includes("**Connected Nodes:**")) {
                    const linkSection = `\n\n---\n**Connected Nodes:**\n${links.map(l => `- ${l}`).join('\n')}`;
                    await this.app.vault.modify(file, content + linkSection);
                }
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
        setTimeout(() => {
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

            new Notice(`Successfully materialized ${exportMap.size} nodes!`);
        }, 100);
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