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

        // Pass 4: 原子交換 (Atomic Swap)
        const currentCanvas = canvas;
        const allData = currentCanvas.getData();
        const exportNodeIds = new Set(exportMap.keys());
        const updatedNodes = allData.nodes.map((n: any) => {
            if (exportNodeIds.has(n.id)) {
                const targetData = exportMap.get(n.id)!;
                return { ...n, type: 'file', file: targetData.fileObj.path, text: undefined };
            }
            return n;
        });

        currentCanvas.deselectAll();
        currentCanvas.setData({ nodes: [], edges: [] }); 

        setTimeout(() => {
            currentCanvas.setData({ nodes: updatedNodes, edges: allData.edges });
            currentCanvas.requestSave();
            new Notice(`Successfully materialized ${exportMap.size} cards!`);
        }, 50);
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