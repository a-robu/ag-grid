import { RowNode } from "../../entities/rowNode";
import { BeanStub } from "../../context/beanStub";
import { RowNodeBlock } from "./rowNodeBlock";
import { Logger } from "../../logger";
import { RowNodeBlockLoader } from "./rowNodeBlockLoader";
import { AgEvent } from "../../events";
import { NumberSequence } from "../../utils";
import { IRowNodeBlock } from "../../interfaces/iRowNodeBlock";
import { Autowired, PostConstruct, PreDestroy } from "../../context/context";
import { RowRenderer } from "../../rendering/rowRenderer";
import { exists, missing } from "../../utils/generic";

export interface RowNodeCacheParams {
    initialRowCount: number;
    blockSize?: number;
    overflowSize: number;
    sortModel: any;
    filterModel: any;
    maxBlocksInCache?: number;
    rowHeight: number;
    lastAccessedSequence: NumberSequence;
    maxConcurrentRequests?: number;
    rowNodeBlockLoader?: RowNodeBlockLoader;
    dynamicRowHeight: boolean;
}

export interface CacheUpdatedEvent extends AgEvent {

}

export abstract class RowNodeCache<T extends IRowNodeBlock, P extends RowNodeCacheParams> extends BeanStub {

    public static EVENT_CACHE_UPDATED = 'cacheUpdated';

    // this property says how many empty blocks should be in a cache, eg if scrolls down fast and creates 10
    // blocks all for loading, the grid will only load the last 2 - it will assume the blocks the user quickly
    // scrolled over are not needed to be loaded.
    private static MAX_EMPTY_BLOCKS_TO_KEEP = 2;

    private virtualRowCount: number;
    private maxRowFound = false;

    @Autowired('rowRenderer') protected rowRenderer: RowRenderer;

    protected cacheParams: P;

    private active: boolean;

    public blocks: { [blockNumber: string]: T; } = {};
    private blockCount = 0;

    protected logger: Logger;

    public abstract getRow(rowIndex: number): RowNode | null;

    protected constructor(cacheParams: P) {
        super();
        this.virtualRowCount = cacheParams.initialRowCount;
        this.cacheParams = cacheParams;
    }

    @PreDestroy
    private destroyAllBlocks(): void {
        this.forEachBlockInOrder(block => this.destroyBlock(block));
    }

    @PostConstruct
    protected init(): void {
        this.active = true;
        this.addDestroyFunc(() => this.active = false);
    }

    public isActive(): boolean {
        return this.active;
    }

    public getVirtualRowCount(): number {
        return this.virtualRowCount;
    }

    public hack_setVirtualRowCount(virtualRowCount: number): void {
        this.virtualRowCount = virtualRowCount;
    }

    public isMaxRowFound(): boolean {
        return this.maxRowFound;
    }

    // listener on EVENT_LOAD_COMPLETE
    protected onPageLoaded(event: any): void {
        this.cacheParams.rowNodeBlockLoader.loadComplete();
        this.checkBlockToLoad();

        // if we are not active, then we ignore all events, otherwise we could end up getting the
        // grid to refresh even though we are no longer the active cache
        if (!this.isActive()) {
            return;
        }

        this.logger.log(`onPageLoaded: page = ${event.page.getBlockNumber()}, lastRow = ${event.lastRow}`);

        if (event.success) {
            this.checkVirtualRowCount(event.page, event.lastRow);
            this.onCacheUpdated();
        }
    }

    private purgeBlocksIfNeeded(blockToExclude: T): void {
        // put all candidate blocks into a list for sorting
        const blocksForPurging: T[] = [];
        this.forEachBlockInOrder((block: T) => {
            // we exclude checking for the page just created, as this has yet to be accessed and hence
            // the lastAccessed stamp will not be updated for the first time yet
            if (block === blockToExclude) {
                return;
            }

            blocksForPurging.push(block);
        });

        // note: need to verify that this sorts items in the right order
        blocksForPurging.sort((a: T, b: T) => b.getLastAccessed() - a.getLastAccessed());

        // we remove (maxBlocksInCache - 1) as we already excluded the 'just created' page.
        // in other words, after the splice operation below, we have taken out the blocks
        // we want to keep, which means we are left with blocks that we can potentially purge
        const maxBlocksProvided = this.cacheParams.maxBlocksInCache > 0;
        const blocksToKeep = maxBlocksProvided ? this.cacheParams.maxBlocksInCache - 1 : null;
        const emptyBlocksToKeep = RowNodeCache.MAX_EMPTY_BLOCKS_TO_KEEP - 1;

        blocksForPurging.forEach((block: T, index: number) => {

            const purgeBecauseBlockEmpty = block.getState() === RowNodeBlock.STATE_DIRTY && index >= emptyBlocksToKeep;

            const purgeBecauseCacheFull = maxBlocksProvided ? index >= blocksToKeep : false;

            if (purgeBecauseBlockEmpty || purgeBecauseCacheFull) {

                // we never purge blocks if they are open, as purging them would mess up with
                // our indexes, it would be very messy to restore the purged block to it's
                // previous state if it had open children (and what if open children of open
                // children, jeeeesus, just thinking about it freaks me out) so best is have a
                // rule, if block is open, we never purge.
                if (block.isAnyNodeOpen(this.virtualRowCount)) { return; }

                // if the block currently has rows been displayed, then don't remove it either.
                // this can happen if user has maxBlocks=2, and blockSize=5 (thus 10 max rows in cache)
                // but the screen is showing 20 rows, so at least 4 blocks are needed.
                if (this.isBlockCurrentlyDisplayed(block)) { return; }

                // at this point, block is not needed, and no open nodes, so burn baby burn
                this.removeBlockFromCache(block);
            }

        });
    }

    private isBlockCurrentlyDisplayed(block: T): boolean {
        const firstViewportRow = this.rowRenderer.getFirstVirtualRenderedRow();
        const lastViewportRow = this.rowRenderer.getLastVirtualRenderedRow();

        const firstRowIndex = block.getDisplayIndexStart();
        const lastRowIndex = block.getDisplayIndexEnd() - 1;

        // parent closed means the parent node is not expanded, thus these blocks are not visible
        const parentClosed = firstRowIndex == null || lastRowIndex == null;
        if (parentClosed) { return false; }

        const blockBeforeViewport = firstRowIndex > lastViewportRow;
        const blockAfterViewport = lastRowIndex < firstViewportRow;
        const blockInsideViewport = !blockBeforeViewport && !blockAfterViewport;

        return blockInsideViewport;
    }

    protected postCreateBlock(newBlock: T): void {
        newBlock.addEventListener(RowNodeBlock.EVENT_LOAD_COMPLETE, this.onPageLoaded.bind(this));
        this.setBlock(newBlock.getBlockNumber(), newBlock);
        this.purgeBlocksIfNeeded(newBlock);
        this.checkBlockToLoad();
    }

    protected removeBlockFromCache(blockToRemove: T): void {
        if (!blockToRemove) {
            return;
        }

        this.destroyBlock(blockToRemove);

        // we do not want to remove the 'loaded' event listener, as the
        // concurrent loads count needs to be updated when the load is complete
        // if the purged page is in loading state
    }

    // gets called after: 1) block loaded 2) block created 3) cache refresh
    protected checkBlockToLoad() {
        this.cacheParams.rowNodeBlockLoader.checkBlockToLoad();
    }

    protected checkVirtualRowCount(block: T, lastRow?: number): void {
        // if client provided a last row, we always use it, as it could change between server calls
        // if user deleted data and then called refresh on the grid.
        if (typeof lastRow === 'number' && lastRow >= 0) {
            this.virtualRowCount = lastRow;
            this.maxRowFound = true;
        } else if (!this.maxRowFound) {
            // otherwise, see if we need to add some virtual rows
            const lastRowIndex = (block.getBlockNumber() + 1) * this.cacheParams.blockSize;
            const lastRowIndexPlusOverflow = lastRowIndex + this.cacheParams.overflowSize;

            if (this.virtualRowCount < lastRowIndexPlusOverflow) {
                this.virtualRowCount = lastRowIndexPlusOverflow;
            }
        }
    }

    public setVirtualRowCount(rowCount: number, maxRowFound?: boolean): void {
        this.virtualRowCount = rowCount;
        // if undefined is passed, we do not set this value, if one of {true,false}
        // is passed, we do set the value.
        if (exists(maxRowFound)) {
            this.maxRowFound = maxRowFound;
        }

        // if we are still searching, then the row count must not end at the end
        // of a particular page, otherwise the searching will not pop into the
        // next page
        if (!this.maxRowFound) {
            if (this.virtualRowCount % this.cacheParams.blockSize === 0) {
                this.virtualRowCount++;
            }
        }

        this.onCacheUpdated();
    }

    public forEachNodeDeep(callback: (rowNode: RowNode, index: number) => void, sequence = new NumberSequence()): void {
        this.forEachBlockInOrder(block => block.forEachNodeDeep(callback, sequence, this.virtualRowCount));
    }

    public forEachBlockInOrder(callback: (block: T, id: number) => void): void {
        const ids = this.getBlockIdsSorted();
        this.forEachBlockId(ids, callback);
    }

    protected forEachBlockInReverseOrder(callback: (block: T, id: number) => void): void {
        const ids = this.getBlockIdsSorted().reverse();
        this.forEachBlockId(ids, callback);
    }

    private forEachBlockId(ids: number[], callback: (block: T, id: number) => void): void {
        ids.forEach(id => {
            const block = this.blocks[id];
            callback(block, id);
        });
    }

    protected getBlockIdsSorted(): number[] {
        // get all page id's as NUMBERS (not strings, as we need to sort as numbers) and in descending order
        const numberComparator = (a: number, b: number) => a - b; // default comparator for array is string comparison
        const blockIds = Object.keys(this.blocks).map(idStr => parseInt(idStr, 10)).sort(numberComparator);
        return blockIds;
    }

    protected getBlock(blockId: string | number): T {
        return this.blocks[blockId];
    }

    protected setBlock(id: number, block: T): void {
        this.blocks[id] = block;
        this.blockCount++;
        this.cacheParams.rowNodeBlockLoader.addBlock(block);
    }

    protected destroyBlock(block: T): void {
        delete this.blocks[block.getBlockNumber()];
        this.destroyBean(block);
        this.blockCount--;
        this.cacheParams.rowNodeBlockLoader.removeBlock(block);
    }

    // gets called 1) row count changed 2) cache purged 3) items inserted
    protected onCacheUpdated(): void {
        if (this.isActive()) {

            // if the virtualRowCount is shortened, then it's possible blocks exist that are no longer
            // in the valid range. so we must remove these. this can happen if user explicitly sets
            // the virtual row count, or the datasource returns a result and sets lastRow to something
            // less than virtualRowCount (can happen if user scrolls down, server reduces dataset size).
            this.destroyAllBlocksPastVirtualRowCount();

            // this results in both row models (infinite and server side) firing ModelUpdated,
            // however server side row model also updates the row indexes first
            const event: CacheUpdatedEvent = {
                type: RowNodeCache.EVENT_CACHE_UPDATED
            };
            this.dispatchEvent(event);
        }
    }

    private destroyAllBlocksPastVirtualRowCount(): void {
        const blocksToDestroy: T[] = [];
        this.forEachBlockInOrder((block: T, id: number) => {
            const startRow = id * this.cacheParams.blockSize;
            if (startRow >= this.virtualRowCount) {
                blocksToDestroy.push(block);
            }
        });
        if (blocksToDestroy.length > 0) {
            blocksToDestroy.forEach(block => this.destroyBlock(block));
        }
    }

    public purgeCache(): void {
        this.forEachBlockInOrder(block => this.removeBlockFromCache(block));
        this.maxRowFound = false;
        // if zero rows in the cache, we need to get the SSRM to start asking for rows again.
        // otherwise if set to zero rows last time, and we don't update the row count, then after
        // the purge there will still be zero rows, meaning the SSRM won't request any rows.
        // to kick things off, at least one row needs to be asked for.
        if (this.virtualRowCount === 0) {
            this.virtualRowCount = this.cacheParams.initialRowCount;
        }

        this.onCacheUpdated();
    }

    public getRowNodesInRange(firstInRange: RowNode, lastInRange: RowNode): RowNode[] {
        const result: RowNode[] = [];

        let lastBlockId = -1;
        let inActiveRange = false;
        const numberSequence: NumberSequence = new NumberSequence();

        // if only one node passed, we start the selection at the top
        if (missing(firstInRange)) {
            inActiveRange = true;
        }

        let foundGapInSelection = false;

        this.forEachBlockInOrder((block: IRowNodeBlock, id: number) => {
            if (foundGapInSelection) { return; }

            if (inActiveRange && (lastBlockId + 1 !== id)) {
                foundGapInSelection = true;
                return;
            }

            lastBlockId = id;

            block.forEachNodeShallow(rowNode => {
                const hitFirstOrLast = rowNode === firstInRange || rowNode === lastInRange;
                if (inActiveRange || hitFirstOrLast) {
                    result.push(rowNode);
                }

                if (hitFirstOrLast) {
                    inActiveRange = !inActiveRange;
                }

            }, numberSequence, this.virtualRowCount);
        });

        // inActiveRange will be still true if we never hit the second rowNode
        const invalidRange = foundGapInSelection || inActiveRange;
        return invalidRange ? [] : result;
    }
}
