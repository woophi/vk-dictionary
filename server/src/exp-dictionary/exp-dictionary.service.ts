import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Dictionary } from 'src/db/tables/Dictionary';
import { Connection, Repository } from 'typeorm';
import * as puppeteer from 'puppeteer';
import * as stripHtml from 'string-strip-html';
import { errMap } from 'src/utils/errors';
import { SearchResult, Shape } from 'src/contracts/search';
import { WordFrequencyService } from 'src/word-frequency/word-frequency.service';

@Injectable()
export class ExpDictionaryService {
  private readonly logger = new Logger(ExpDictionaryService.name);

  constructor(
    @InjectRepository(Dictionary)
    private tableDict: Repository<Dictionary>,
    private connection: Connection,
    private wordFreqService: WordFrequencyService,
  ) {}

  async fullTextSearch(query: string) {
    const r = (await this.tableDict.query(`
      select
        id,
        definition,
        ps.rank
      from
        (
        select
          id,
          name,
          definition,
          to_tsvector(ts_config_name, name) as document,
          ts_rank(to_tsvector(ts_config_name, name), to_tsquery('${query}:*')) as rank
        from
          dictionary ) ps
      where
        ps.document @@ to_tsquery('${query}:*')
      order by ps.rank desc;
    `)) as SearchResult[];

    let response: SearchResult[] = [];

    if (!r?.length) {
      const parsed = await this.parsePage(query);

      if (parsed.srs?.length) {
        const results = await this.saveNewToDictionary(parsed.srs);
        response = results ?? [];
      }
    } else {
      this.silentParse(query);
      response = r ?? [];
    }

    if (response.length) {
      this.wordFreqService.incrementFrequency(response.map((r) => r.id));
    }

    return response;
  }

  async parsePage(query: string) {
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();

    await page.goto(
      `https://povto.ru/russkie/slovari/tolkovie/ozhegova/search_ozhegov.php?q_tolk_ozh=${encodeURIComponent(
        query,
      )}`,
    );

    let data = await page.evaluate((q) => {
      const content2 = document.querySelector('.w3-container');
      const children = content2?.children ?? [];

      const srs = [];
      for (let child of children) {
        let src = child?.id?.includes(q) ? child : null;

        if (src) {
          srs.push(src.innerHTML);
        }
      }

      return {
        srs,
      };
    }, query);
    await browser.close();
    return data;
  }

  async saveNewToDictionary(srcs: string[]) {
    const queryRunner = this.connection.createQueryRunner();
    const results: SearchResult[] = [];

    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const shapes = this.shapeScrapedValues(srcs);

      for (const shape of shapes) {
        const exists =
          (await queryRunner.manager.count<Dictionary>(Dictionary, {
            where: { name: shape.name },
          })) > 0;

        if (exists) {
          continue;
        }

        const newDictValue = new Dictionary(
          shape.name,
          shape.defenition,
          shape.plainDefenition,
        );
        await queryRunner.manager.save(newDictValue);
        results.push({
          id: newDictValue.id,
          definition: newDictValue.definition,
        });
      }

      await queryRunner.commitTransaction();
      return results;
    } catch (err) {
      this.logger.error(errMap(err));
      await queryRunner.rollbackTransaction();
      throw new Error(err);
    } finally {
      await queryRunner.release();
    }
  }

  shapeScrapedValues(srcs: string[]) {
    const shapes: Shape[] = [];
    for (const src of srcs) {
      let shape: Shape = {
        defenition: '',
        name: '',
        plainDefenition: '',
      };

      const nameMatches = src.match(/<dfn>(.*?)<\/dfn>/g);

      if (nameMatches?.length) {
        const cleanName =
          stripHtml(nameMatches[0] ?? '')
            .result?.replace(/\s/g, '')
            .replace(',', '')
            .toLowerCase() ?? '';

        if (!cleanName) continue;

        shape.name = cleanName;
      }

      shape.defenition = src;
      shape.plainDefenition = stripHtml(src).result;
      shapes.push(shape);
    }
    return shapes;
  }

  async silentParse(query: string) {
    const parsed = await this.parsePage(query);
    if (parsed.srs?.length) {
      this.saveNewToDictionary(parsed.srs);
    }
  }

  async getWordInfo(wordId: string) {
    const word = await this.tableDict.findOne(wordId, {
      select: ['id', 'definition'],
    });
    return word;
  }
}
