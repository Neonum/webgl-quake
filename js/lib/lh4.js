// LH4, LHA (-lh4-) extractor, no crc/sum-checks. Will extract SFX-archives as well.
// Erland Ranvinge (erland.ranvinge@gmail.com)
// Based on a mix of Nobuyasu Suehiro's Java implementation and Simon Howard's C version.

var LhaArrayReader = function(buffer) {
    this.buffer = buffer;
    this.offset = 0;
    this.subOffset = 7;
};
LhaArrayReader.SeekAbsolute = 0;
LhaArrayReader.SeekRelative = 1;

LhaArrayReader.prototype.readBits = function(bits) {
    var bitMasks = [1, 2, 4, 8, 16, 32, 64, 128];
    var byte = this.buffer[this.offset];
    var result = 0;

    for (var bitIndex = 0; bitIndex < bits; bitIndex++) {
        var bit = (byte & bitMasks[this.subOffset]) >> this.subOffset;
        result <<= 1;
        result = result | bit;
        this.subOffset--;
        if (this.subOffset < 0) {
            if (this.offset + 1 >= this.buffer.length)
                return -1;

            byte = this.buffer[++this.offset];
            this.subOffset = 7;
        }
    }
    return result;
};

LhaArrayReader.prototype.readUInt8 = function() {
    if (this.offset + 1 >= this.buffer.length)
        return -1;
    return this.buffer[this.offset++];
};
LhaArrayReader.prototype.readUInt16 = function() {
    if (this.offset + 2 >= this.buffer.length)
        return -1;
    var value =
        (this.buffer[this.offset] & 0xFF) |
        ((this.buffer[this.offset+1] << 8) & 0xFF00);
    this.offset += 2;
    return value;
};
LhaArrayReader.prototype.readUInt32 = function() {
    if (this.offset + 4 >= this.buffer.length)
        return -1;
    var value =
        (this.buffer[this.offset] & 0xFF) |
        ((this.buffer[this.offset+1] << 8) & 0xFF00) |
        ((this.buffer[this.offset+2] << 16) & 0xFF0000) |
        ((this.buffer[this.offset+3] << 24) & 0xFF000000);
    this.offset += 4;
    return value;
};
LhaArrayReader.prototype.readString = function(size) {
    if (this.offset + size >= this.buffer.length)
        return -1;
    var result = '';
    for (var i = 0; i < size; i++)
        result += String.fromCharCode(this.buffer[this.offset++]);
    return result;
};

LhaArrayReader.prototype.readLength = function() {
    var length = this.readBits(3);
    if (length == -1)
        return -1;

    if (length == 7) {
        while (this.readBits(1) != 0) {
            length++;
        }
    }
    return length;
};
LhaArrayReader.prototype.seek = function(offset, mode) {
    switch (mode) {
        case LhaArrayReader.SeekAbsolute:
            this.offset = offset;
            this.subOffset = 7;
            break;
        case LhaArrayReader.SeekRelative:
            this.offset += offset;
            this.subOffset = 7;
            break;
    }
};
LhaArrayReader.prototype.getPosition = function() {
    return this.offset;
};

var LhaArrayWriter = function(size) {
    this.offset = 0;
    this.size = size;
    this.data = new Uint8Array(size);
};

LhaArrayWriter.prototype.write = function(data) {
    this.data[this.offset++] = data;
};

var LhaTree = function() {};
LhaTree.LEAF = 1 << 15;

LhaTree.prototype.setConstant = function(code) {
    this.tree[0] = code | LhaTree.LEAF;
};

LhaTree.prototype.expand = function() {
    var endOffset = this.allocated;
    while (this.nextEntry < endOffset) {
        this.tree[this.nextEntry] = this.allocated;
        this.allocated += 2;
        this.nextEntry++;
    }
};

LhaTree.prototype.addCodesWithLength = function(codeLengths, codeLength) {
    var done = true;
    for (var i = 0; i < codeLengths.length; i++) {
        if (codeLengths[i] == codeLength) {
            var node = this.nextEntry++;
            this.tree[node] = i | LhaTree.LEAF;
        } else if (codeLengths[i] > codeLength) {
            done = false;
        }
    }
    return done;
};

LhaTree.prototype.build = function(codeLengths, size) {
    this.tree = [];
    for (var i = 0; i < size; i++)
        this.tree[i] = LhaTree.LEAF;

    this.nextEntry = 0;
    this.allocated = 1;
    var codeLength = 0;
    do {
        this.expand();
        codeLength++;
    } while (!this.addCodesWithLength(codeLengths, codeLength));
};

LhaTree.prototype.readCode = function(reader) {
    var code = this.tree[0];
    while ((code & LhaTree.LEAF) == 0) {
        var bit = reader.readBits(1);
        code = this.tree[code + bit];
    }
    return code & ~LhaTree.LEAF;
};

var LhaRingBuffer = function(size) {
    this.data = [];
    this.size = size;
    this.offset = 0;
};

LhaRingBuffer.prototype.add = function(value) {
    this.data[this.offset] = value;
    this.offset = (this.offset + 1) % this.size;
};

LhaRingBuffer.prototype.get = function(offset, length) {
    var pos = this.offset + this.size - offset - 1;
    var result = [];
    for (var i = 0; i < length; i++) {
        var code = this.data[(pos + i) % this.size];
        result.push(code);
        this.add(code);
    }
    return result;
};

var LhaReader = function(reader) {
    this.reader = reader;
    this.offsetTree = new LhaTree();
    this.codeTree = new LhaTree();
    this.ringBuffer = new LhaRingBuffer(1 << 13); // lh4 specific.
    this.entries = {};

    if (reader.readString(2) == 'MZ') { // Check for SFX header, and skip it if it exists.
        var lastBlockSize = reader.readUInt16();
        var blockCount = reader.readUInt16();
        var offset = (blockCount - 1) * 512 + (lastBlockSize != 0 ? lastBlockSize : 512);
        reader.seek(offset, LhaArrayReader.SeekAbsolute);
    } else {
        reader.seek(0, LhaArrayReader.SeekAbsolute);
    }

    for (;;) {
        var header = {};
        header.size = reader.readUInt8();
        if (header.size <= 0)
            break;

        header.checksum = reader.readUInt8();
        header.id = reader.readString(5);
        header.packedSize = reader.readUInt32();
        header.originalSize = reader.readUInt32();
        header.datetime = reader.readUInt32();
        header.attributes = reader.readUInt16();
        var filenameSize = reader.readUInt8();
        header.filename = reader.readString(filenameSize).toLowerCase();
        header.crc = reader.readUInt16();
        header.offset = reader.getPosition();
        this.entries[header.filename] = header;
        reader.seek(header.packedSize, LhaArrayReader.SeekRelative);
    }
};

LhaReader.prototype.readTempTable = function () {
    var reader = this.reader;
    var codeCount = Math.min(reader.readBits(5), 19);
    if (codeCount <= 0) {
        var constant = reader.readBits(5);
        this.offsetTree.setConstant(constant);
        return;
    }
    var codeLengths = [];
    for (var i = 0; i < codeCount; i++) {
        var codeLength = reader.readLength();
        codeLengths.push(codeLength);
        if (i == 2) { // The dreaded special bit that no-one (including me) seems to understand.
            var length = reader.readBits(2);
            while (length-- > 0) {
                codeLengths.push(0);
                i++;
            }
        }
    }
    this.offsetTree.build(codeLengths, 19 * 2);
};

LhaReader.prototype.readCodeTable = function() {
    var reader = this.reader;
    var codeCount = Math.min(reader.readBits(9), 510);
    if (codeCount <= 0) {
        var constant = reader.readBits(9);
        this.codeTree.setConstant(constant);
        return;
    }

    var codeLengths = [];
    for (var i = 0; i < codeCount; ) {
        var code = this.offsetTree.readCode(reader);
        if (code <= 2) {
            var skip = 1;
            if (code == 1)
                skip = reader.readBits(4) + 3;
            else if (code == 2)
                skip = reader.readBits(9) + 20;
            while (--skip >= 0) {
                codeLengths.push(0);
                i++;
            }
        } else {
            codeLengths.push(code - 2);
            i++;
        }
    }
    this.codeTree.build(codeLengths, 510 * 2);
};

LhaReader.prototype.readOffsetTable = function() {
    var reader = this.reader;
    var codeCount = Math.min(reader.readBits(4), 14);
    if (codeCount <= 0) {
        var constant = reader.readBits(4);
        this.offsetTree.setConstant(constant);
    } else {
        var codeLengths = [];
        for (var i = 0; i < codeCount; i++) {
            var code = reader.readLength();
            codeLengths[i] = code;
        }
        this.offsetTree.build(codeLengths, 19 * 2);
    }
};

LhaReader.prototype.extract = function(id, callback) {
    var entry = this.entries[id];
    if (!entry)
        return null;

    this.reader.seek(entry.offset, LhaArrayReader.SeekAbsolute);
    
    var writer = new LhaArrayWriter(entry.originalSize);

    while(true) {
        if (!this.extractBlock(writer))
            break;
        if (writer.offset >= writer.size)
            break;;
    }
    return writer.data;
};

LhaReader.prototype.extractBlock = function(writer) {
    var reader = this.reader;
    var blockSize = reader.readBits(16);
    if (blockSize <= 0 || reader.offset >= reader.size)
        return false;

    this.readTempTable();
    this.readCodeTable();
    this.readOffsetTable();

    for (var i = 0; i < blockSize; i++) {
        var code = this.codeTree.readCode(reader);
        if (code < 256) {
            this.ringBuffer.add(code);
            writer.write(code);
        } else {
            var bits = this.offsetTree.readCode(reader);
            var offset = bits;
            if (bits >= 2) {
                var offset = reader.readBits(bits - 1);
                offset = offset + (1 << (bits - 1));
            }

            var length = code - 256 + 3;
            var chunk = this.ringBuffer.get(offset, length);
            for (var j in chunk)
                writer.write(chunk[j]); // TODO: Look at bulk-copying this.
        }
    }
    return true;
};

module.exports = exports = {
    'LhaArrayReader': LhaArrayReader,
    'LhaReader': LhaReader
}
